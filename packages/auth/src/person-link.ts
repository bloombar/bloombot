/**
 * Connecting a second surface (LINK-1..5): the proof half of D-28's design.
 *
 * Mirrors `discord-install.ts`'s own OAuth+PKCE shape closely — a random
 * secret, returned once and stored only as a hash, a PKCE verifier kept in
 * plain text for the same reason (D-21) — except this proves who a *person*
 * is, not who administers a server.
 *
 * `@bloombot/db`'s `person_link_challenges` (one table, two `surface`
 * values) is the storage half; this file is the business logic — generating
 * and hashing secrets, computing the PKCE challenge, and (once a proof has
 * actually succeeded) composing `@bloombot/db`'s `people.ts#connectIdentity`/
 * `#mergePeople` to attach or merge the proven identity. Nothing here binds
 * an identity on a visit alone (LINK-3): `beginDiscordPersonLink` and
 * `issueMcpPersonLinkToken` only ever write a challenge row — nothing about
 * either side of the eventual connection is touched until `completeDiscordPersonLink`/
 * `completeMcpPersonLink` runs with an actual proof in hand. `previewDiscordPersonLink`/
 * `previewMcpPersonLink` let a caller inspect what completing *would* do —
 * which person, which identity, whether it will merge — without spending
 * the secret, for LINK-3's own "the page names the account being connected
 * and waits to be told to proceed".
 *
 * D-35 rework, finding 3 — which side of the proof is bound at *issue* time
 * is not the same for both surfaces, and getting this backwards is an
 * account takeover, not a cosmetic asymmetry. Discord's own OAuth genuinely
 * proves a snowflake once the callback runs, so `beginDiscordPersonLink`
 * binds the *survivor* — "the account being connected" (D-28) — and
 * `completeDiscordPersonLink` additionally has to confirm whoever calls it
 * back is the same caller who began it (Discord's OAuth result alone proves
 * the identity, not who is sitting at the browser that redeems it — see
 * that function's own doc comment). MCP has no sign-in of its own: LINK-3's
 * "a single-use, expiring token delivered where only that caller can read
 * it" is itself the proof of the *identity* being connected, so
 * `issueMcpPersonLinkToken` binds that identity at issue — before any
 * survivor is known — and `completeMcpPersonLink` takes the survivor from
 * its own caller instead, which is safe *because* the identity side is
 * already fixed by the token: a caller can only ever attach the one
 * identity the token was issued for, never assert an arbitrary one. Compare
 * `discord-install.ts`: there, the thing being proven (which account is
 * installing) is bound at issue, and Discord's own OAuth result (which
 * server) is what gets attached — the same shape this file's Discord half
 * follows; before this rework, the MCP half had it backwards (the survivor
 * bound at issue, the identity asserted by whoever redeemed), which let a
 * redeemer name an arbitrary victim's identity and absorb them.
 */

import { createHash } from 'node:crypto'

import {
  people,
  personLinkChallenges,
  type Database,
  type Executor,
  type TransactingExecutor,
} from '@bloombot/db'

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
  /** Embed as the `state` query parameter. Single-use; presented back to `consumeDiscordPersonLink`/`completeDiscordPersonLink` on callback. */
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
 * in its refusal for a state that never existed, one issued for the other
 * surface, one already used, and one that has expired (the same "no oracle"
 * guarantee `discord-install.ts#consumeDiscordInstallState` already gives
 * TEN-4).
 *
 * `db` accepts `Executor`, not just `Database`: `completeDiscordPersonLink`
 * calls this from inside its own transaction.
 */
export function consumeDiscordPersonLink(
  state: string,
  db: Executor
): ConsumedDiscordPersonLink | undefined {
  const consumed = personLinkChallenges.consumeChallenge(
    hashSecret(state),
    'discord',
    Date.now(),
    db
  )
  // `surface` is guaranteed by `consumeChallenge`'s own `WHERE`, and
  // `personId` by `schema.ts`'s `CHECK` (a `discord` row always binds the
  // survivor). `codeVerifier` is guaranteed by neither — the `CHECK`
  // constrains `person_id` and `identity_external_id` only — but by
  // `NewPersonLinkChallenge`'s discriminated union, which requires it for
  // `discord`. Not re-checked here, since a row this query returns at all
  // already satisfies all three.
  if (!consumed) return undefined
  return {
    organizationId: consumed.organizationId,
    personId: consumed.personId as string,
    codeVerifier: consumed.codeVerifier as string,
  }
}

/**
 * Peek at a Discord person-link state's own PKCE verifier — LINK-6/7's own
 * missing link: `apps/api`'s connect route has to run the token exchange
 * itself (`code`/`codeVerifier` → an access token, `LINK-7`'s own module
 * comment) *before* it can call `previewDiscordPersonLink` with a real
 * snowflake, but `consumeDiscordPersonLink` — the only other place a
 * `codeVerifier` was ever readable — spends the state doing it, which would
 * make preview and confirm race for who gets to consume it, and preview
 * always wins, leaving confirm with nothing left to redeem. This is the
 * read-only twin `consumeDiscordPersonLink` needed all along: the same
 * `peekChallenge` lookup `previewDiscordPersonLink` itself already uses,
 * returning the one extra field a preview never otherwise exposes (the
 * verifier is not part of `PersonLinkPreview` — it is not something a page
 * displays, only something a server needs to finish an exchange). Refuses
 * for the identical reasons every other peek/consume in this file does — an
 * unknown, expired, wrong-surface, or already-used state.
 */
export function peekDiscordPersonLinkCodeVerifier(
  state: string,
  db: Executor
): ConsumedDiscordPersonLink | undefined {
  const peeked = personLinkChallenges.peekChallenge(
    hashSecret(state),
    'discord',
    Date.now(),
    db
  )
  if (!peeked) return undefined
  return {
    organizationId: peeked.organizationId,
    personId: peeked.personId as string,
    codeVerifier: peeked.codeVerifier as string,
  }
}

/**
 * Peek at a Discord person-link state without redeeming it — LINK-3's own
 * "the page names the account being connected and waits to be told to
 * proceed": once Discord's OAuth has already returned `code` (and this
 * caller has already exchanged it for `discordExternalId`, proving the
 * snowflake — this function does not do that exchange, see this file's own
 * module comment for why), a caller can show what completing *would* do —
 * which person, which identity, whether it merges someone in — before
 * asking the person to confirm. `undefined` for the same reasons
 * `consumeDiscordPersonLink` refuses.
 *
 * Rework — `callerPersonId` is the same fix `completeDiscordPersonLink`
 * already applies at redemption, applied here too: before this, nothing
 * checked that whoever calls *preview* is the same caller `state` was
 * issued to, which let a holder of a valid state (their own, legitimately
 * begun attempt) call this repeatedly with a classmate's already-known
 * snowflake and learn, from the `outcome`, that classmate's own internal
 * person id and whether they had ever proven an identity to this platform
 * at all — an oracle `state`'s own single-use design never intended to
 * expose, since preview spends nothing and so was never gated behind
 * anything. Checked the identical way `completeDiscordPersonLink` checks it
 * (a mismatch reads exactly like a state that never existed, LINK-3's own
 * "no oracle" guarantee) — and, unlike a redemption, a preview mismatch
 * costs the state nothing: nothing here is single-use, so there is no
 * "spent either way" rule to apply.
 */
export function previewDiscordPersonLink(
  state: string,
  discordExternalId: string,
  callerPersonId: string,
  db: Executor
): PersonLinkPreview | undefined {
  const peeked = personLinkChallenges.peekChallenge(
    hashSecret(state),
    'discord',
    Date.now(),
    db
  )
  if (!peeked) return undefined
  if (peeked.personId !== callerPersonId) return undefined
  const identity: PersonIdentityInput = {
    surface: 'discord',
    externalId: discordExternalId,
  }
  return previewOutcome(
    peeked.organizationId,
    peeked.personId as string,
    identity,
    db
  )
}

/**
 * Complete a Discord person-link: redeem `state`, confirm `callerPersonId`
 * — the person whoever is calling this back is *already* authenticated as,
 * established by this caller's own session, entirely independent of
 * anything `state` carries — matches the survivor `beginDiscordPersonLink`
 * recorded, then attach or merge the snowflake Discord's own OAuth actually
 * proved (`discordExternalId` — the caller's job to have obtained this from
 * Discord's token exchange and `/users/@me`, not this function's; see this
 * file's own module comment for why that HTTP round trip is not built
 * here).
 *
 * D-35 rework, finding 3 — `callerPersonId` is the fix for state fixation:
 * before this, nothing tied the browser that *redeems* a state to the one
 * that *began* it, so an attacker could begin their own attempt (as
 * themselves, the survivor), hand the resulting authorization URL to a
 * victim, and absorb the victim's Discord identity the moment the victim
 * approved it — Discord's own consent screen proves the victim's snowflake,
 * but proves nothing about whose attempt the victim was completing.
 * Refusing a mismatch here — inside the one function this module advertises
 * for completing a Discord connection, not left for a future callback route
 * to remember to check — closes that: only the same caller `state` was
 * issued to can ever complete it. The state is still consumed on a
 * mismatch, the same "spent either way" rule every single-use secret in
 * this package already follows (`tokens.ts#consumeSignInToken`'s own
 * comment) — no retry, whatever the outcome.
 *
 * Runs as one transaction (D-35 rework, finding 7): a redeemed state whose
 * attach-or-merge then fails must not stay spent.
 *
 * Two shapes for the attach/merge half, depending on whether this Discord
 * identity has ever been seen before (PPL-3 may already have created a
 * person for it, on its own first message):
 *  - never seen: `people.ts#connectIdentity` attaches it directly to the
 *    survivor `state` names.
 *  - already belongs to a *different* person: `people.ts#mergePeople`
 *    combines that person into the survivor (LINK-4).
 *  - already belongs to *this same* survivor: idempotent, nothing further to
 *    do — `connectIdentity`'s own idempotent branch handles this.
 *
 * `undefined` when `state` does not redeem, or when `callerPersonId` does
 * not match the survivor `state` was issued for (LINK-3's own refusal,
 * unchanged by whatever `discordExternalId` was supplied).
 */
export function completeDiscordPersonLink(
  state: string,
  discordExternalId: string,
  callerPersonId: string,
  db: Database
): Person | undefined {
  return db.transaction((tx) => {
    const consumed = consumeDiscordPersonLink(state, tx)
    if (!consumed) return undefined
    if (consumed.personId !== callerPersonId) return undefined
    return connectOrMerge(
      consumed.organizationId,
      consumed.personId,
      { surface: 'discord', externalId: discordExternalId },
      tx
    )
  })
}

/** What issuing an MCP person-link token returns. */
export interface IssuedMcpPersonLinkToken {
  /** The value to hand back in the MCP tool result (LINK-3: "delivered where only that caller can read it"). Never recoverable from the database afterward. */
  token: string
  expiresAt: number
}

/**
 * Issue a single-use, expiring token to connect an MCP identity — LINK-3's
 * "a token that never left a private channel": this function only mints the
 * value; delivering it inside the MCP tool result (never posted anywhere a
 * third party could read it) is the MCP server's own job, out of this
 * slice's scope (this slice's brief: "provides the token mechanism, not the
 * server").
 *
 * Bound to `mcpExternalId` — the identity being connected — at issue, not
 * to a survivor (D-35 rework, finding 3, this file's own module comment):
 * the token is delivered to the unconnected MCP caller, who is the one who
 * knows their own external id; no survivor exists to name yet.
 */
export function issueMcpPersonLinkToken(
  organizationId: string,
  mcpExternalId: string,
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
      surface: 'mcp',
      identityExternalId: mcpExternalId,
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
  /** The identity this token was issued for — bound at issue, never caller-supplied at redemption (finding 3). */
  identity: PersonIdentityInput
}

/**
 * Redeem an MCP person-link token (LINK-3): single-use and expiring, the
 * same "no oracle" refusal `consumeDiscordPersonLink` gives above — a token
 * that never existed, one issued for the other surface, one already
 * redeemed, and one that has expired all refuse identically.
 *
 * `db` accepts `Executor`, not just `Database`: `completeMcpPersonLink`
 * calls this from inside its own transaction.
 */
export function consumeMcpPersonLinkToken(
  token: string,
  db: Executor
): ConsumedMcpPersonLinkToken | undefined {
  const consumed = personLinkChallenges.consumeChallenge(
    hashSecret(token),
    'mcp',
    Date.now(),
    db
  )
  if (!consumed) return undefined
  return {
    organizationId: consumed.organizationId,
    identity: {
      surface: 'mcp',
      externalId: consumed.identityExternalId as string,
    },
  }
}

/**
 * Peek at an MCP person-link token without redeeming it — the same
 * non-committing preview `previewDiscordPersonLink` gives, for a caller
 * that already knows (from its own already-authenticated session) which
 * person would be the survivor if this token were redeemed right now.
 */
export function previewMcpPersonLink(
  token: string,
  callerPersonId: string,
  db: Executor
): PersonLinkPreview | undefined {
  const peeked = personLinkChallenges.peekChallenge(
    hashSecret(token),
    'mcp',
    Date.now(),
    db
  )
  if (!peeked) return undefined
  const identity: PersonIdentityInput = {
    surface: 'mcp',
    externalId: peeked.identityExternalId as string,
  }
  return previewOutcome(peeked.organizationId, callerPersonId, identity, db)
}

/**
 * Complete an MCP person-link: redeem `token`, then attach or merge the
 * identity it was issued for onto `survivorPersonId` — supplied by this
 * function's own caller from *its* already-authenticated session (LINK-3's
 * own "redeemed by the signed-in account, which is what proves the
 * survivor"), never read out of the token or asserted by an unauthenticated
 * request. Safe for the caller to assert, unlike the pre-rework shape this
 * replaced (finding 3): the *identity* side is fixed by the token, bound at
 * issue, so whoever redeems a given token can only ever attach the one
 * identity it names — never an arbitrary one — regardless of which
 * survivor they claim to be.
 *
 * Runs as one transaction (finding 7): a redeemed token whose attach-or-merge
 * then fails must not stay spent.
 */
export function completeMcpPersonLink(
  token: string,
  survivorPersonId: string,
  db: Database
): Person | undefined {
  return db.transaction((tx) => {
    const consumed = consumeMcpPersonLinkToken(token, tx)
    if (!consumed) return undefined
    return connectOrMerge(
      consumed.organizationId,
      survivorPersonId,
      consumed.identity,
      tx
    )
  })
}

/**
 * The shared "attach, or merge" combinator both `completeDiscordPersonLink`
 * and `completeMcpPersonLink` reduce to once their own proof has redeemed:
 * try `connectIdentity` first (the common case — this identity has never
 * been proven before), and fall back to `mergePeople` only when the identity
 * already belongs to someone else (LINK-4). `db` accepts
 * `people.TransactingExecutor`-shaped input (both callers hand this their
 * own open transaction) so the whole redeem-then-attach/merge sequence
 * commits or fails together.
 */
function connectOrMerge(
  organizationId: string,
  survivorPersonId: string,
  identity: PersonIdentityInput,
  db: TransactingExecutor
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

/** What either `preview*PersonLink` function reports — LINK-3's own non-committing inspection. */
export interface PersonLinkPreview {
  organizationId: string
  survivorPersonId: string
  identity: PersonIdentityInput
  outcome: PersonLinkPreviewOutcome
}

export type PersonLinkPreviewOutcome =
  // The identity has never been seen — completing this would attach it
  // directly to the survivor, `connectIdentity`'s own main branch.
  | { kind: 'attach' }
  // The identity already belongs to the survivor — completing this would be
  // a no-op, `connectIdentity`'s own idempotent branch.
  | { kind: 'already-connected' }
  // The identity belongs to a *different* person — completing this would
  // merge that person (`existingPersonId`) into the survivor (LINK-4). The
  // page this preview exists for is exactly where a real product would show
  // that person's own transcript/conversation count before asking anyone to
  // confirm merging it in.
  | { kind: 'merge'; existingPersonId: string }

/**
 * Shared by `previewDiscordPersonLink`/`previewMcpPersonLink`: resolves what
 * `connectOrMerge` *would* do for `(organizationId, survivorPersonId, identity)`
 * without writing anything — a plain read against `people.ts#resolveIdentity`.
 *
 * Rework — checks the survivor's own `mergedIntoPersonId` first, and refuses
 * (the same `undefined` every other preview refusal here uses) when it is
 * set. Before this, a survivor merged away *after* their own connect attempt
 * began (D-35 rework, finding 2's own race — a faster, different proof
 * merging them into someone else while their challenge is still live) still
 * previewed as `{ kind: 'attach' }`: `resolveIdentity` alone has no way to
 * know the *survivor* side of the pair is stale, only whether the *identity*
 * side is already claimed. `connectOrMerge`'s real `connectIdentity` call
 * refuses outright the moment `personId` names a merged-away person
 * (`people.ts`'s own doc comment) — so the preview this function built
 * promised an outcome `completeDiscordPersonLink`/`completeMcpPersonLink`
 * would then refuse to deliver, exactly the gap LINK-6 exists to close ("the
 * page can describe the outcome without spending the proof" only holds if
 * the description is honest). A Discord survivor is ordinarily kept current
 * by `repointOutstandingChallenges` (`person-link-challenges.ts`, run inside
 * `mergePeople`'s own transaction) — this check is what still holds for the
 * MCP half, which carries no survivor at issue time to repoint at all, and
 * as a second, structural guard against the same race on the Discord half.
 */
function previewOutcome(
  organizationId: string,
  survivorPersonId: string,
  identity: PersonIdentityInput,
  db: Executor
): PersonLinkPreview | undefined {
  const survivor = people.getPerson(organizationId, survivorPersonId, db)
  if (!survivor || survivor.mergedIntoPersonId !== null) return undefined

  const existingOwner = people.resolveIdentity(organizationId, identity, db)
  const outcome: PersonLinkPreviewOutcome = !existingOwner
    ? { kind: 'attach' }
    : existingOwner.id === survivorPersonId
      ? { kind: 'already-connected' }
      : { kind: 'merge', existingPersonId: existingOwner.id }
  return { organizationId, survivorPersonId, identity, outcome }
}
