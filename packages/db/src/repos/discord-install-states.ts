/**
 * Repository for `discord_install_states` (TEN-4).
 *
 * The server-side half of the Discord install flow's OAuth+PKCE dance: one
 * row per attempt, from `@bloombot/auth#beginDiscordInstall` generating a
 * state and a PKCE verifier, to the callback consuming it exactly once.
 * Keyed on the state's *hash* — a callback request carries only the state
 * value Discord echoed back, not an organization id, so this is one more
 * "found before any organization scoping applies" exception, the same class
 * `sign-in-tokens.ts` documents for itself, and allowlisted in
 * `tests/tenant-scoping-convention.test.ts` accordingly.
 */

import { and, eq, gt, isNull, lt } from 'drizzle-orm'

import type { Executor } from '../client.js'
import { discordInstallStates } from '../schema.js'

export type DiscordInstallState = typeof discordInstallStates.$inferSelect

/** Fields the caller supplies when beginning an install. */
export interface NewDiscordInstallState {
  /** Defaults to `crypto.randomUUID()` when omitted. */
  id?: string
  organizationId: string
  accountId: string
  /** SHA-256 hash of the state value; see `@bloombot/auth`'s `discord-install.ts`. */
  stateHash: string
  /**
   * The PKCE verifier, in plain text. Unlike `stateHash`, this cannot be
   * stored hashed: the callback has to hand it to Discord's token endpoint
   * verbatim to complete the exchange, and a hash cannot be turned back into
   * the value that produced it. See docs/DECISIONS.md D-21.
   */
  codeVerifier: string
  expiresAt: number
}

/** Begin (insert) a new install-state row. */
export function createInstallState(
  input: NewDiscordInstallState,
  db: Executor
): DiscordInstallState {
  return db
    .insert(discordInstallStates)
    .values({
      id: input.id ?? crypto.randomUUID(),
      organizationId: input.organizationId,
      accountId: input.accountId,
      stateHash: input.stateHash,
      codeVerifier: input.codeVerifier,
      expiresAt: input.expiresAt,
      createdAt: Date.now(),
    })
    .returning()
    .get()
}

/**
 * Redeem an install state by its hash: atomically marks it used and returns
 * the row — the same single conditional `UPDATE`
 * `sign-in-tokens.ts#consumeSignInToken` uses for AUTH-1, so two concurrent
 * callbacks presenting the same state resolve to exactly one winner rather
 * than both completing the install.
 *
 * Returns `undefined` for a hash that was never issued, one already used,
 * and one that has expired — identically in all three cases, so a callback
 * cannot use the response to tell which one happened (the same "no oracle"
 * guarantee AUTH-1 requires of a sign-in token).
 */
export function consumeInstallState(
  stateHash: string,
  now: number,
  db: Executor
): DiscordInstallState | undefined {
  return db
    .update(discordInstallStates)
    .set({ usedAt: now })
    .where(
      and(
        eq(discordInstallStates.stateHash, stateHash),
        isNull(discordInstallStates.usedAt),
        gt(discordInstallStates.expiresAt, now)
      )
    )
    .returning()
    .get()
}

/**
 * Delete every install-state row whose `expiresAt` has already passed
 * (cheap-fix 8 of the TEN-4..6 rework) — called by
 * `@bloombot/auth#beginDiscordInstall` right before it inserts a new row,
 * so an account that begins (and abandons) installs over time does not
 * leave an unbounded number of dead rows behind. Not a "one live attempt at
 * a time" guard the way `sign-in-tokens.ts#hasActiveSignInToken` is for
 * AUTH-1: that guard exists because `/auth/request-link` is unauthenticated
 * and unthrottled, so a single address left unguarded is an unbounded
 * mail-send. `/install/begin` is neither — a caller is already signed in
 * and a member of the organization it is installing into — so a second,
 * legitimate concurrent attempt (a second tab, a retried click after an
 * abandoned first one) is not the failure mode worth refusing here; only
 * the row growth from every one of them living forever is, and a sweep on
 * write closes that without restricting a legitimate retry the way
 * refusing a second live attempt would.
 *
 * Deletes a used-but-expired row too, not only an unused one — once
 * `expiresAt` has passed, `consumeInstallState` above will never match the
 * row again either way, so there is nothing left for it to do but occupy
 * space.
 */
export function deleteExpiredInstallStates(now: number, db: Executor): number {
  const result = db
    .delete(discordInstallStates)
    .where(lt(discordInstallStates.expiresAt, now))
    .run()
  return result.changes
}
