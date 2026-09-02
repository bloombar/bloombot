/**
 * The sign-in flows: request a link, redeem a link, sign in with Google.
 *
 * This is the one file that reaches across `tokens.ts`, `sessions.ts`,
 * `link.ts`, `admin.ts`'s siblings and `@bloombot/db`'s `accounts`/
 * `organizations` repos to do the thing AUTH-1/AUTH-2/TEN-1 actually
 * describe: turn a proven identity into a session, creating an account and
 * its personal organization on the way in for a first-time sign-in — all in
 * one transaction, so a failure partway through (a bad foreign key, a
 * unique-constraint collision) leaves none of account, organization or
 * membership behind.
 */

import BetterSqlite3 from 'better-sqlite3'

import {
  accounts as accountsRepo,
  memberships as membershipsRepo,
  organizations as organizationsRepo,
  people as peopleRepo,
  signInTokens as signInTokensRepo,
  type Database,
  type TransactingExecutor,
} from '@bloombot/db'

import type { EmailSender } from './email.js'
import { decideLinkOutcome, type GoogleIdentity } from './link.js'
import {
  issueSignInToken,
  consumeSignInToken,
  discardSignInToken,
} from './tokens.js'
import {
  createSession,
  revokeAllSessions,
  type CreatedSession,
} from './sessions.js'

type Account = accountsRepo.Account

/** The outcome of any of this file's sign-in flows: a session, and whether it required creating a new account. */
export interface SignInResult {
  account: Account
  session: CreatedSession
  /** `true` when this call created the account (TEN-1: with its personal organization and membership), `false` for a returning account. */
  createdAccount: boolean
}

/**
 * Turn an email address into a display name when nothing better is known —
 * the local part, `.`/`_`/`-` treated as word breaks and each word
 * capitalized (`jane.doe` → `Jane Doe`). A placeholder, not an identity
 * claim: nothing here asserts this is the account holder's real name, and a
 * later profile-editing flow is expected to replace it. Falls back to the
 * raw email when the local part is empty or entirely non-letters, so this
 * never produces a blank `displayName` — `accounts.displayName` is
 * `NOT NULL`.
 */
function displayNameFromEmail(email: string): string {
  const localPart = email.split('@')[0] ?? ''
  const words = localPart
    .split(/[._-]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0)
  if (words.length === 0) return email
  return words
    .map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

/**
 * WEB-10/LINK-1 rework — a signed-in web caller *is* the account: they
 * proved control of it by signing in, which is exactly the proof LINK-3
 * asks of every other surface's own connect step, so requiring a *second*,
 * separate "connect your web account" action would be asking for proof
 * this function already has. Creates the account's own person, in its own
 * personal organization (the only organization this function's own caller
 * has just created — `apps/web`'s chat surface resolves a person per
 * organization, never creates one, so any *other* organization a future
 * roster import or join-link admits this account into still needs its own
 * connect step, same as any other surface), and connects it immediately
 * through `people.ts#connectIdentity` — the real, merged LINK-3 path, not a
 * raw `connectedAt` column write, so this person is indistinguishable from
 * one connected by an actual proof (LINK-4's own merge and LINK-5's own
 * shared allowance apply to it exactly the same way once a future connect
 * flow attaches a Discord or MCP identity on top of it).
 *
 * Called only from each of this file's own account-*creation* branches
 * (`findOrCreateAccountForEmail`'s and `tryCreateAccountForEmail`'s "new
 * account" paths) — never on a returning sign-in, which already has its own
 * person from the first time this ran.
 */
function createConnectedWebPerson(
  organizationId: string,
  accountId: string,
  db: TransactingExecutor
): void {
  const person = peopleRepo.createPerson(organizationId, {}, db)
  // `connectIdentity` refuses (`undefined`) on exactly three conditions
  // (its own doc comment): `personId` foreign or absent, `personId` already
  // merged away, or the identity already belonging to a *different* person.
  // None can fire here — `organizationId` and `person.id` were both just
  // minted in this same transaction, and `{ surface: 'web', externalId:
  // accountId }` cannot already belong to anyone else, because this
  // function only ever runs once per account (the account-creation path,
  // or `healWebPersonForReturningAccount` below, itself gated on
  // `resolveIdentity` finding nothing first). Rework finding: this used to
  // discard the return value, so a refusal here — unreachable today, but
  // silently so — would have left a person with `connectedAt` still `null`
  // and no identity at all, indistinguishable from working until the very
  // next chat request refused it. A throw makes that unreachability
  // structural rather than argued.
  const connected = peopleRepo.connectIdentity(
    organizationId,
    person.id,
    { surface: 'web', externalId: accountId },
    db
  )
  if (!connected) {
    throw new Error(
      `createConnectedWebPerson: connectIdentity refused for a person (${person.id}) and organization (${organizationId}) this function just created — should be unreachable`
    )
  }
}

/**
 * LINK-9's own healing path. `createConnectedWebPerson` above only ever ran
 * on the account-*creation* path — an account that signed up before this
 * rework shipped has no web person at all, silently and permanently:
 * `routes/chat.ts` finds nothing to resolve and refuses `chat_not_connected`
 * forever, with no configuration and no later sign-in that fixes it, and
 * nothing tells either the instructor or an operator why. Called on every
 * *returning* sign-in (both `findOrCreateAccountForEmail`'s own "existing"
 * branch and `signInWithGoogle`'s own "link" branch), inside the same
 * transaction the caller already has: finds the account's own personal
 * organization (TEN-1's own one — the only organization this function has
 * any business creating a person in; any *other* organization's own connect
 * step is LINK-3's proof, not this healing path's job) via
 * `memberships.listMembershipsForAccount` and `organizations.getOrganizationById`,
 * and creates+connects a person there only if `resolveIdentity` finds
 * none — idempotent, so a returning account that already has one (every
 * account created after this rework) pays one cheap indexed read and does
 * nothing further.
 */
function healWebPersonForReturningAccount(
  accountId: string,
  db: TransactingExecutor
): void {
  const accountMemberships = membershipsRepo.listMembershipsForAccount(
    accountId,
    db
  )
  let personalOrganizationId: string | undefined
  for (const membership of accountMemberships) {
    const organization = organizationsRepo.getOrganizationById(
      membership.organizationId,
      db
    )
    if (organization?.isPersonal) {
      personalOrganizationId = organization.id
      break
    }
  }
  // TEN-1 guarantees every account has exactly one personal organization,
  // created atomically with it — unreachable in practice, but guarded
  // rather than assumed, the same discipline this file already holds
  // `createConnectedWebPerson`'s own `connectIdentity` check to just above.
  if (!personalOrganizationId) return

  const existing = peopleRepo.resolveIdentity(
    personalOrganizationId,
    { surface: 'web', externalId: accountId },
    db
  )
  if (existing) return

  createConnectedWebPerson(personalOrganizationId, accountId, db)
}

/**
 * Find the account for `email`, or create one with a fresh personal
 * organization, an `owner` membership and a connected web person, atomically
 * (TEN-1, and `createConnectedWebPerson`'s own doc comment for the person).
 * Must be called with `db` already inside the caller's own transaction —
 * this function does not open one of its own, so its writes (organization,
 * account+membership — `accountsRepo.createAccount` already wraps those two
 * atomically — then the person) commit or fail as part of whatever the
 * caller is doing.
 */
function findOrCreateAccountForEmail(
  email: string,
  db: TransactingExecutor
): { account: Account; createdAccount: boolean } {
  const existing = accountsRepo.getAccountByEmail(email, db)
  if (existing) return { account: existing, createdAccount: false }

  const organizationId = crypto.randomUUID()
  organizationsRepo.createOrganization(
    organizationId,
    { name: displayNameFromEmail(email), isPersonal: true },
    db
  )
  const account = accountsRepo.createAccount(
    organizationId,
    { email, displayName: displayNameFromEmail(email), role: 'owner' },
    db
  )
  createConnectedWebPerson(organizationId, account.id, db)
  return { account, createdAccount: true }
}

/** Deps `requestSignInLink` needs beyond the email address itself. */
export interface RequestSignInLinkDeps {
  db: Database
  /** The mail port (`email.ts`) this is sent through — a real transport in production, `RecordingEmailSender` in a test. */
  emailSender: EmailSender
  /** Turns an issued token into the actual URL the emailed link points at — this package has no notion of the web app's own base URL or route. */
  buildLink: (token: string) => string
}

/**
 * Request a sign-in link (AUTH-1, finding 4 of the AUTH-1..4 rework): issues
 * a token and emails it through `deps.emailSender` — the thing `email.ts`'s
 * own module comment already described this file as doing, before anything
 * here actually called it.
 *
 * Returns nothing: the plaintext token's only destination is the outgoing
 * email, never a value this function hands back to its own caller to log,
 * cache, or otherwise let escape the mail port.
 *
 * @throws whatever `deps.emailSender.send` throws — see the `catch` below
 *   for why this is not swallowed.
 */
export async function requestSignInLink(
  email: string,
  deps: RequestSignInLinkDeps
): Promise<void> {
  // "Also worth doing" of the API-1..6 rework: `/auth/request-link`
  // (`apps/api`) is unauthenticated, and its own origin check is trivially
  // bypassed by a non-browser caller, so without a guard here a single
  // address is an unbounded mail-send and row-insert. A cheap structural
  // one: decline to issue (and to send mail for) a second token while an
  // earlier one for this address is still unexpired and unused. Silent, on
  // purpose — this function's own caller (`routes/auth.ts`) already answers
  // the same way whether or not the address has an account, and answering
  // differently here would give a flooding caller an oracle for "is a link
  // already outstanding" that AUTH-1 gives nobody today.
  if (signInTokensRepo.hasActiveSignInToken(email, Date.now(), deps.db)) {
    return
  }
  const { token } = issueSignInToken(email, deps.db)
  try {
    await deps.emailSender.send(
      email,
      'Sign in to Bloombot',
      `Use this link to sign in to Bloombot: ${deps.buildLink(token)}`
    )
  } catch (error) {
    // AUTH-5's must-fix 1: until this slice, the only senders in this
    // codebase were a file writer and a logger, neither of which throws in
    // practice, so a token this call issued but never actually delivered
    // was not a case worth handling. A real transport routinely does throw
    // — a relay blip, a rejected recipient — and without this, the token
    // row above stays live: `hasActiveSignInToken` would then silently
    // decline every retry for the rest of its fifteen-minute lifetime,
    // this function returning cleanly and its caller (`routes/auth.ts`)
    // answering `204` on every one of them, while nothing is ever sent —
    // exactly what AUTH-5's own text forbids ("accepting a sign-in it will
    // silently drop"). Discarding the token here — not consuming it, since
    // it was never legitimately redeemed — reopens the address for an
    // immediate retry instead of a fifteen-minute lockout, and the error
    // still propagates (this function's own contract, and `email.ts`'s
    // `EmailSender` doc comment: "implementations may throw; `sign-in.ts`
    // does not catch on the caller's behalf") so `routes/auth.ts`'s
    // `.catch(next)` still answers the caller honestly rather than a false
    // `204`.
    discardSignInToken(token, deps.db)
    throw error
  }
}

/**
 * Redeem a sign-in link (AUTH-1).
 *
 * The token is consumed, the account is found or created, and the session
 * is opened, all inside one `db.transaction(...)` — the "consumed in the
 * same transaction that creates the session" AUTH-1 requires, and TEN-1's
 * "a failure part-way leaves none of the three" for a first-time sign-in.
 *
 * Returns `undefined` for a token that was invalid, already redeemed,
 * expired, or that resolves to a disabled account (finding 3 of the
 * AUTH-1..4 rework — the token itself is still consumed either way: it was
 * legitimately issued and legitimately redeemed, so letting it be replayed
 * later, once the account might be re-enabled, would reopen exactly the
 * single-use property AUTH-1 requires) — `tokens.ts#consumeSignInToken`'s
 * "no oracle" guarantee holds for the first three cases, since this is the
 * only thing this function does differently for them.
 *
 * For a *returning* account (`createdAccount: false`), every other session
 * that account currently holds is revoked before the new one is created
 * (finding 2 of the AUTH-1..4 rework, belt-and-braces half): redeeming an
 * emailed link is proof of control of the address, and proving that is
 * exactly the moment to invalidate anything issued before the proof — an
 * attacker who reached this account first (an unverified Google identity
 * that used to create rather than reject, say) does not get to keep a
 * session alive once the real owner shows up.
 */
export function redeemSignInLink(
  token: string,
  db: Database
): SignInResult | undefined {
  return db.transaction((tx) => {
    const consumed = consumeSignInToken(token, tx)
    if (!consumed) return undefined

    const { account, createdAccount } = findOrCreateAccountForEmail(
      consumed.email,
      tx
    )
    if (account.disabledAt !== null) return undefined

    if (!createdAccount) {
      revokeAllSessions(account.id, tx)
      // LINK-9's own healing path — a returning account created before
      // this rework shipped otherwise has no web person at all, silently
      // and permanently (`healWebPersonForReturningAccount`'s own doc
      // comment has the full account).
      healWebPersonForReturningAccount(account.id, tx)
    }

    const session = createSession(account.id, tx)
    return { account, session, createdAccount }
  })
}

/**
 * Sign in with a Google identity already verified by `google.ts` (AUTH-2).
 *
 * Looks up whatever account exists for the asserted email, asks
 * `link.ts#decideLinkOutcome` whether to link to it, create a new one, or
 * reject the attempt outright, and acts on the answer inside one
 * transaction, same as `redeemSignInLink`.
 *
 * A verified, matching email links to the existing account (refused,
 * without creating a session, if that account is disabled — finding 3 of
 * the AUTH-1..4 rework). A verified email matching nobody yet creates a new
 * account. An *unverified* email is rejected outright — whether or not it
 * matches an existing account (finding 2 of the AUTH-1..4 rework: an
 * unverified assertion proves nothing about who controls the address, so it
 * must not be able to reach an account *or* pre-create one). See
 * docs/DECISIONS.md (D-19).
 *
 * Rotates on the `link` branch the same way `redeemSignInLink` does for a
 * returning sign-in (must-fix 2 of the API-1..6 rework): every other session
 * this account already holds is revoked before the new one is created. A
 * successful Google sign-in is proof of control of the address, same as
 * redeeming an emailed link, and is exactly the moment to invalidate
 * whatever a session cookie captured earlier in that account's lifetime was
 * still carrying — without this, a stolen cookie survived the victim signing
 * in again through Google, the natural response to suspecting compromise.
 */
export function signInWithGoogle(
  identity: GoogleIdentity,
  db: Database
): SignInResult | undefined {
  return db.transaction((tx) => {
    const existing = accountsRepo.getAccountByEmail(identity.email, tx)
    const decision = decideLinkOutcome(identity, existing?.email)

    if (decision.action === 'reject') return undefined

    let account: Account
    let createdAccount = false
    if (decision.action === 'link' && existing) {
      if (existing.disabledAt !== null) return undefined
      account = existing
      revokeAllSessions(account.id, tx)
      // LINK-9's own healing path — the same "returning account, might
      // pre-date this rework" case `redeemSignInLink`'s own comment
      // describes.
      healWebPersonForReturningAccount(account.id, tx)
    } else {
      const created = tryCreateAccountForEmail(identity.email, tx)
      if (!created) return undefined
      account = created
      createdAccount = true
    }

    const session = createSession(account.id, tx)
    return { account, session, createdAccount }
  })
}

/**
 * `findOrCreateAccountForEmail`'s "create" half, on its own: used only by
 * `signInWithGoogle`'s `create` branch, reached only for a *verified* email
 * that `existing` (read moments earlier, outside this transaction's own
 * writes) found no account for. That read-then-write gap is exactly what
 * can make the insert itself fail — a second concurrent sign-in (this one,
 * or a `redeemSignInLink` racing it) creating the same account first — so
 * `undefined` is returned on that failure rather than letting the driver's
 * raw constraint error escape, the same "report a routine refusal, not a
 * thrown error" shape `discord-servers.ts#claimDiscordServerBinding` uses
 * for TEN-3.
 */
function tryCreateAccountForEmail(
  email: string,
  db: TransactingExecutor
): Account | undefined {
  // The `try`/`catch` wraps the *call* to `db.transaction(...)`, not the
  // code inside it: a thrown error must unwind through the transaction's own
  // `catch` first (`rollback to savepoint`, in drizzle's better-sqlite3
  // driver) so the organization insert above it is undone before this
  // function ever gets a chance to swallow the error and return `undefined`
  // — catching *inside* the callback would let that organization row commit
  // as an orphan alongside the account insert's refusal.
  try {
    return db.transaction((tx) => {
      const organizationId = crypto.randomUUID()
      organizationsRepo.createOrganization(
        organizationId,
        { name: displayNameFromEmail(email), isPersonal: true },
        tx
      )
      const account = accountsRepo.createAccount(
        organizationId,
        { email, displayName: displayNameFromEmail(email), role: 'owner' },
        tx
      )
      createConnectedWebPerson(organizationId, account.id, tx)
      return account
    })
  } catch (error) {
    if (isUniqueEmailViolation(error)) return undefined
    throw error
  }
}

/**
 * Whether `error` is SQLite's own report of a duplicate `accounts.email` —
 * matched on the driver's own error type and code
 * (`discord-servers.ts#claimDiscordServerBinding` catches its own primary-key
 * race the same way), plus the constraint's own message identifying the
 * column, rather than reported as an opaque thrown error a caller would have
 * to recognise some other way.
 */
function isUniqueEmailViolation(error: unknown): boolean {
  return (
    error instanceof BetterSqlite3.SqliteError &&
    error.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    error.message.includes('accounts.email')
  )
}
