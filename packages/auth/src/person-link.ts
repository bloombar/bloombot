/**
 * Connecting a second surface (LINK-1..5): the proof half of D-28's design.
 *
 * Mirrors `discord-install.ts`'s own OAuth+PKCE shape closely — a random
 * secret, returned once and stored only as a hash, a PKCE verifier kept in
 * plain text for the same reason (D-21) — except this proves who a *person*
 * is, not who administers a server: `beginDiscordPersonLink`/
 * `issueMcpPersonLinkToken` are begun against "the account being connected"
 * (D-28), a `personId`, never an `accountId`.
 *
 * `@bloombot/db`'s `person_link_challenges` (one table, two `surface`
 * values) is the storage half; this file is the business logic — generating
 * and hashing secrets, computing the PKCE challenge, and (once a proof has
 * actually succeeded) composing `@bloombot/db`'s `people.ts#connectIdentity`/
 * `#mergePeople` to attach or merge the proven identity. Nothing here binds
 * an identity on a visit alone (LINK-3): `beginDiscordPersonLink` and
 * `issueMcpPersonLinkToken` only ever write a challenge row — the person
 * this attempt is for is untouched until `completeDiscordPersonLink`/
 * `completeMcpPersonLink` is called with an actual proof in hand.
 */

import { createHash } from 'node:crypto'

import { people, personLinkChallenges, type Database } from '@bloombot/db'

import { generateSecret, hashSecret } from './secrets.js'

type Person = people.Person
type PersonIdentityInput = people.PersonIdentityInput

// LINK-3 gives no explicit number. Ten minutes, the same ceiling
// `discord-install.ts`'s `DEFAULT_INSTALL_STATE_TTL_MS` already uses for the
// same reason: long enough to review and approve Discord's own consent
// screen (or, for MCP, to carry a token from a tool result into wherever it
// is redeemed) with no delivery delay to accommodate, short enough that an
// abandoned attempt cannot be resumed hours later.
export const DEFAULT_PERSON_LINK_TTL_MS = 10 * 60 * 1000

/** RFC 7636 §4.2's S256 code challenge — duplicated from `discord-install.ts` rather than shared (that file's own module comment: this package's convention for a two-line helper neither file owns exclusively). */
function computeCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url')
}

/** What beginning a Discord person-link attempt returns. */
export interface BeginDiscordPersonLink {
  /** Embed as the `state` query parameter. Single-use; presented back to `consumeDiscordPersonLink` on callback. */
  state: string
  /** Embed as the `code_challenge` query parameter, with `code_challenge_method=S256`. */
  codeChallenge: string
  expiresAt: number
}

/**
 * Begin connecting a Discord identity to `personId` — "the account being
 * connected" (D-28), already known before Discord's own OAuth ever starts.
 * Generates a state and a PKCE verifier, and stores the verifier in plain
 * text (D-21's own reasoning, unchanged from `discord-install.ts`).
 */
export function beginDiscordPersonLink(
  organizationId: string,
  personId: string,
  db: Database,
  ttlMs: number = DEFAULT_PERSON_LINK_TTL_MS
): BeginDiscordPersonLink {
  const now = Date.now()
  // Cheap-fix 8 of the TEN-4..6 rework applied to this table too — see
  // `@bloombot/db`'s `deleteExpiredChallenges` doc comment for why this is a
  // sweep-on-write rather than a "one live attempt" refusal: a person who
  // abandons a connect attempt (closes the tab mid-consent) must not leave
  // an unbounded number of dead rows behind.
  personLinkChallenges.deleteExpiredChallenges(now, db)

  const state = generateSecret()
  const codeVerifier = generateSecret()
  const expiresAt = now + ttlMs
  personLinkChallenges.createChallenge(
    {
      organizationId,
      personId,
      surface: 'discord',
      secretHash: hashSecret(state),
      codeVerifier,
      expiresAt,
    },
    db
  )
  return { state, codeChallenge: computeCodeChallenge(codeVerifier), expiresAt }
}

/** What a redeemed Discord person-link state resolves to. */
export interface ConsumedDiscordPersonLink {
  organizationId: string
  personId: string
  /** The PKCE verifier this attempt began with — pass to Discord's token exchange's `code_verifier` field, verbatim. */
  codeVerifier: string
}

/**
 * Redeem a Discord person-link state (LINK-3): single-use, indistinguishable
 * in its refusal for a state that never existed, one already used, and one
 * that has expired (the same "no oracle" guarantee `discord-install.ts#consumeDiscordInstallState`
 * already gives TEN-4).
 */
export function consumeDiscordPersonLink(
  state: string,
  db: Database
): ConsumedDiscordPersonLink | undefined {
  const consumed = personLinkChallenges.consumeChallenge(
    hashSecret(state),
    Date.now(),
    db
  )
  if (!consumed || consumed.surface !== 'discord' || !consumed.codeVerifier) {
    return undefined
  }
  return {
    organizationId: consumed.organizationId,
    personId: consumed.personId,
    codeVerifier: consumed.codeVerifier,
  }
}

/**
 * Complete a Discord person-link: redeem `state`, then attach or merge the
 * snowflake Discord's own OAuth actually proved (`discordExternalId` — the
 * caller's job to have obtained this from Discord's token exchange and
 * `/users/@me`, not this function's; see this file's own module comment for
 * why that HTTP round trip is not built here).
 *
 * Two shapes, depending on whether this Discord identity has ever been seen
 * before (PPL-3 may already have created a person for it, on its own first
 * message):
 *  - never seen: `people.ts#connectIdentity` attaches it directly to the
 *    survivor `state` names.
 *  - already belongs to a *different* person: `people.ts#mergePeople`
 *    combines that person into the survivor (LINK-4).
 *  - already belongs to *this same* survivor: idempotent, nothing further to
 *    do — `connectIdentity`'s own idempotent branch handles this.
 *
 * `undefined` when `state` does not redeem (LINK-3's own refusal, unchanged
 * by whatever `discordExternalId` was supplied).
 */
export function completeDiscordPersonLink(
  state: string,
  discordExternalId: string,
  db: Database
): Person | undefined {
  const consumed = consumeDiscordPersonLink(state, db)
  if (!consumed) return undefined
  return connectOrMerge(
    consumed.organizationId,
    consumed.personId,
    { surface: 'discord', externalId: discordExternalId },
    db
  )
}

/** What issuing an MCP person-link token returns. */
export interface IssuedMcpPersonLinkToken {
  /** The value to hand back in the MCP tool result (LINK-3: "delivered where only that caller can read it"). Never recoverable from the database afterward. */
  token: string
  expiresAt: number
}

/**
 * Issue a single-use, expiring token to connect an MCP identity to
 * `personId` — LINK-3's "a token that never left a private channel": this
 * function only mints the value; delivering it inside the MCP tool result
 * (never posted anywhere a third party could read it) is the MCP server's
 * own job, out of this slice's scope (this slice's brief: "provides the
 * token mechanism, not the server").
 */
export function issueMcpPersonLinkToken(
  organizationId: string,
  personId: string,
  db: Database,
  ttlMs: number = DEFAULT_PERSON_LINK_TTL_MS
): IssuedMcpPersonLinkToken {
  const now = Date.now()
  // Same sweep-on-write as `beginDiscordPersonLink` above, for the same
  // reason.
  personLinkChallenges.deleteExpiredChallenges(now, db)

  const token = generateSecret()
  const expiresAt = now + ttlMs
  personLinkChallenges.createChallenge(
    {
      organizationId,
      personId,
      surface: 'mcp',
      secretHash: hashSecret(token),
      expiresAt,
    },
    db
  )
  return { token, expiresAt }
}

/** What a redeemed MCP person-link token resolves to. */
export interface ConsumedMcpPersonLinkToken {
  organizationId: string
  personId: string
}

/**
 * Redeem an MCP person-link token (LINK-3): single-use and expiring, the
 * same "no oracle" refusal `consumeDiscordPersonLink` gives above — a token
 * that never existed, one already redeemed, and one that has expired all
 * refuse identically.
 */
export function consumeMcpPersonLinkToken(
  token: string,
  db: Database
): ConsumedMcpPersonLinkToken | undefined {
  const consumed = personLinkChallenges.consumeChallenge(
    hashSecret(token),
    Date.now(),
    db
  )
  if (!consumed || consumed.surface !== 'mcp') return undefined
  return {
    organizationId: consumed.organizationId,
    personId: consumed.personId,
  }
}

/**
 * Complete an MCP person-link: redeem `token`, then attach or merge the MCP
 * identity it was issued for (`mcpExternalId` — whatever id the MCP client
 * asserts for itself, the same role a Discord snowflake plays above). LINK-3's
 * own reasoning for why possessing the token is the proof itself, for a
 * surface with no sign-in of its own: only the caller the token was
 * delivered to could ever present it back.
 */
export function completeMcpPersonLink(
  token: string,
  mcpExternalId: string,
  db: Database
): Person | undefined {
  const consumed = consumeMcpPersonLinkToken(token, db)
  if (!consumed) return undefined
  return connectOrMerge(
    consumed.organizationId,
    consumed.personId,
    { surface: 'mcp', externalId: mcpExternalId },
    db
  )
}

/**
 * The shared "attach, or merge" combinator both `completeDiscordPersonLink`
 * and `completeMcpPersonLink` reduce to once their own proof has redeemed:
 * try `connectIdentity` first (the common case — this identity has never
 * been proven before), and fall back to `mergePeople` only when the identity
 * already belongs to someone else (LINK-4).
 */
function connectOrMerge(
  organizationId: string,
  survivorPersonId: string,
  identity: PersonIdentityInput,
  db: Database
): Person | undefined {
  const attached = people.connectIdentity(
    organizationId,
    survivorPersonId,
    identity,
    db
  )
  if (attached) return people.getPerson(organizationId, survivorPersonId, db)

  const existingOwner = people.resolveIdentity(organizationId, identity, db)
  if (!existingOwner) return undefined
  if (existingOwner.id === survivorPersonId) return existingOwner

  const merged = people.mergePeople(
    organizationId,
    survivorPersonId,
    existingOwner.id,
    db
  )
  return merged?.survivor
}
