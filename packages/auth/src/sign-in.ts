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
  organizations as organizationsRepo,
  type Database,
  type TransactingExecutor,
} from '@bloombot/db'

import { decideLinkOutcome, type GoogleIdentity } from './link.js'
import { consumeSignInToken } from './tokens.js'
import { createSession, type CreatedSession } from './sessions.js'

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
 * Find the account for `email`, or create one with a fresh personal
 * organization and an `owner` membership, atomically (TEN-1). Must be
 * called with `db` already inside the caller's own transaction — this
 * function does not open one of its own, so its two writes (organization,
 * then account+membership — `accountsRepo.createAccount` already wraps
 * those two atomically) commit or fail as part of whatever the caller is
 * doing.
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
  return { account, createdAccount: true }
}

/**
 * Redeem a sign-in link (AUTH-1).
 *
 * The token is consumed, the account is found or created, and the session
 * is opened, all inside one `db.transaction(...)` — the "consumed in the
 * same transaction that creates the session" AUTH-1 requires, and TEN-1's
 * "a failure part-way leaves none of the three" for a first-time sign-in.
 *
 * Returns `undefined` for a token that was invalid, already redeemed, or
 * expired — `tokens.ts#consumeSignInToken`'s "no oracle" guarantee holds
 * here too, since this is the only thing this function does differently for
 * those three cases.
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
    const session = createSession(account.id, tx)
    return { account, session, createdAccount }
  })
}

/**
 * Sign in with a Google identity already verified by `google.ts` (AUTH-2).
 *
 * Looks up whatever account exists for the asserted email, asks
 * `link.ts#decideLinkOutcome` whether to link to it or create a new one, and
 * acts on the answer inside one transaction, same as `redeemSignInLink`.
 *
 * A verified, matching email links to the existing account. Everything else
 * — no existing account, a verified email that does not match one, or an
 * *unverified* email that happens to match one (the takeover AUTH-2 names)
 * — creates a new account rather than reaching the existing one. Because
 * `accounts.email` is unique, a new account cannot literally reuse an email
 * string an existing row already holds; when that collision happens for the
 * unverified-match case, account creation itself fails and this function
 * refuses the sign-in (returns `undefined`) rather than linking — refusing
 * is still "not the existing account", which is the property AUTH-2
 * requires. See docs/DECISIONS.md.
 */
export function signInWithGoogle(
  identity: GoogleIdentity,
  db: Database
): SignInResult | undefined {
  return db.transaction((tx) => {
    const existing = accountsRepo.getAccountByEmail(identity.email, tx)
    const decision = decideLinkOutcome(identity, existing?.email)

    let account: Account
    let createdAccount = false
    if (decision.action === 'link' && existing) {
      account = existing
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
 * `signInWithGoogle`'s "otherwise a new account is created" branch, where —
 * unlike `redeemSignInLink` — the email may already belong to a *different*
 * account (the unverified-match case above), so the insert itself may fail.
 * `undefined` on that failure rather than letting the driver's raw
 * constraint error escape, the same "report a routine refusal, not a thrown
 * error" shape `discord-servers.ts#claimDiscordServerBinding` uses for
 * TEN-3.
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
      return accountsRepo.createAccount(
        organizationId,
        { email, displayName: displayNameFromEmail(email), role: 'owner' },
        tx
      )
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
