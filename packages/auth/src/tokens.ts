/**
 * Single-use sign-in tokens (AUTH-1).
 *
 * Everything a token *is* — random, returned once, stored only as a hash,
 * single-use, minutes-lived — lives here. What a redeemed token *does*
 * (find or create the account, open a session) is `sign-in.ts`'s job: this
 * module never imports `accounts.ts` or `sessions.ts`, and `consumeSignInToken`
 * is written to be called from inside a caller-owned `db.transaction(...)`
 * so the redemption and whatever it unlocks commit or fail together.
 */

import { signInTokens, type Database, type Executor } from '@bloombot/db'
import { z } from 'zod'

import { generateSecret, hashSecret } from './secrets.js'

const emailSchema = z.email()

// AUTH-1: "expire within minutes". Fifteen minutes is long enough that an
// email delivered a little late (a slow mail queue, a spam-filter delay)
// still works, short enough that a link sitting unread in an inbox — or
// forwarded, or leaked via a mail provider's own logs — stops being useful
// well within the same sitting.
export const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000

// Finding 5 of the AUTH-1..4 rework: `issueSignInToken`'s `ttlMs` parameter
// had no upper bound, so a caller could issue a link that stayed valid for
// months — AUTH-1's "expire within minutes" would then be a convention a
// caller could simply not follow, rather than something this module
// actually enforces. Equal to `DEFAULT_TOKEN_TTL_MS`: nothing about a
// sign-in link needs to live longer than the deliberately-chosen default,
// so there is no legitimate reason for a caller to ask for more.
export const MAX_TOKEN_TTL_MS = DEFAULT_TOKEN_TTL_MS

/** What a caller gets back from issuing a token — the plaintext value, exactly once. */
export interface IssuedSignInToken {
  /** The value to put in the emailed link. Never recoverable from the database afterward. */
  token: string
  expiresAt: number
}

// AUTH-6: same-origin means "begins with exactly one `/`" — never `//` or
// `/\`, both of which a browser resolves as protocol-relative (an *off*-origin
// address, `//evil.example` behaving exactly like `https://evil.example`
// despite looking like a path). This is deliberately conservative: the only
// values this ever has to admit are the handful of paths `apps/web`'s own
// pages issue a sign-in link for (`/join/:secret`, `/connect/:organizationId`),
// never an arbitrary caller's.
const SAME_ORIGIN_PATH_PREFIX = /^\/(?!\/|\\)/

/**
 * AUTH-6 — whether `value` is safe to carry as a sign-in token's own
 * `destination` and, later, to navigate a browser to once redeemed.
 * `apps/web` has no router and treats every path it is handed as trusted
 * (`App.tsx`'s own `history.replaceState`), so this is the one gate between
 * "a caller-supplied string" and "the browser's own address bar" — a
 * `destination` this codebase must treat as untrusted input the same way
 * any other caller-supplied redirect target would be, spec'd explicitly in
 * `docs/SPEC.md`'s own AUTH-6.
 *
 * Beyond `SAME_ORIGIN_PATH_PREFIX` (above), this also refuses any character
 * at or below `0x20` — every whitespace character and every C0 control
 * character in one comparison — that a URL parser further down the line
 * could reinterpret; a plain char-code loop rather than folding the range
 * into the regex itself, which `eslint`'s own `no-control-regex` refuses a
 * literal control character inside (for the same reason this function
 * exists: a raw control character is exactly the kind of thing worth a
 * second look, not a pattern to suppress the linter over).
 */
export function isSameOriginPath(value: string): boolean {
  if (!SAME_ORIGIN_PATH_PREFIX.test(value)) return false
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x20) return false
  }
  return true
}

/**
 * Issue a new sign-in token for an email address.
 *
 * Does not check whether an account with this email exists — a first-time
 * sign-in and a returning one request a link the same way; `sign-in.ts`
 * decides at redemption time whether to create an account. Does reject a
 * malformed address up front (`zod`'s own `email()` check) — refusing here
 * is cheap and immediate, versus discovering the same problem only once
 * something tries, and fails, to send mail to it. `ttlMs` is clamped to
 * `MAX_TOKEN_TTL_MS` (finding 5 of the AUTH-1..4 rework) — a caller asking
 * for less than the default still gets exactly what it asked for; only a
 * request for *more* than the ceiling is capped.
 *
 * `destination` (AUTH-6): the same-origin path this token should return to
 * once redeemed, carried on the row itself rather than in the browser tab
 * that requested it (`schema.ts`'s own comment on `sign_in_tokens.destination`
 * has why). Rejected outright, the same way a malformed `email` already is,
 * rather than stored and only discovered bad later — `apps/api`'s own route
 * validates the same way before this ever runs (`isSameOriginPath`, this
 * file's own export), so reaching here with a bad one should not happen; this
 * still refuses it rather than assuming that validation always ran.
 *
 * @throws {z.ZodError} if `email` is not a syntactically valid address.
 * @throws {Error} if `destination` is supplied and is not a same-origin path.
 */
export function issueSignInToken(
  email: string,
  db: Database,
  ttlMs: number = DEFAULT_TOKEN_TTL_MS,
  destination?: string
): IssuedSignInToken {
  emailSchema.parse(email)
  if (destination !== undefined && !isSameOriginPath(destination)) {
    throw new Error(
      `issueSignInToken: destination must be a same-origin path, got ${JSON.stringify(destination)}`
    )
  }
  const token = generateSecret()
  const expiresAt = Date.now() + Math.min(ttlMs, MAX_TOKEN_TTL_MS)
  signInTokens.createSignInToken(
    {
      email,
      tokenHash: hashSecret(token),
      expiresAt,
      destination: destination ?? null,
    },
    db
  )
  return { token, expiresAt }
}

/** What a redeemed token resolves to. */
export interface ConsumedSignInToken {
  email: string
  /** AUTH-6 — the same-origin path this token was issued to return to, if any; `undefined` for an ordinary sign-in, or for a stored value that (should never, but) fails `isSameOriginPath` on the way back out — see `consumeSignInToken`'s own comment on why this is checked again here, not only at issue time. */
  destination: string | undefined
}

/**
 * Redeem a sign-in token: single-use, and atomic with whatever the caller
 * does next.
 *
 * Call this *inside* the same `db.transaction(...)` that creates the
 * session (AUTH-1) — `db` here should be the transaction's own handle, not
 * a fresh connection, so a failure later in that transaction (account
 * creation, session creation) rolls the redemption back too rather than
 * burning the token on a sign-in that never completed.
 *
 * Returns `undefined` for a token that never existed, one already redeemed,
 * and one that has expired — identically in all three cases, so a caller
 * cannot use the response to tell replay apart from a wrong guess.
 *
 * `destination` is re-validated with `isSameOriginPath` here, not merely
 * trusted off the row — `issueSignInToken` already refused to store a bad
 * one, so this should never actually fire, but this is the one function
 * standing between "whatever this column holds" and a caller
 * (`sign-in.ts#redeemSignInLink`) that hands it straight to a browser to
 * navigate to; "defended, not assumed" the same way every other
 * should-be-unreachable case in this codebase is guarded rather than
 * trusted.
 */
export function consumeSignInToken(
  token: string,
  db: Executor
): ConsumedSignInToken | undefined {
  const consumed = signInTokens.consumeSignInToken(
    hashSecret(token),
    Date.now(),
    db
  )
  if (!consumed) return undefined
  return {
    email: consumed.email,
    destination:
      consumed.destination !== null && isSameOriginPath(consumed.destination)
        ? consumed.destination
        : undefined,
  }
}

/**
 * Discard an issued sign-in token outright, without redeeming it — AUTH-5's
 * must-fix 1: `sign-in.ts#requestSignInLink` calls this when the mail
 * carrying the token fails to send, so the still-live row `issueSignInToken`
 * just wrote does not sit there making `hasActiveSignInToken`
 * (`@bloombot/db`'s `sign-in-tokens.ts`) refuse every retry for the rest of
 * the token's own lifetime, on a link nobody ever received.
 */
export function discardSignInToken(token: string, db: Executor): void {
  signInTokens.deleteSignInToken(hashSecret(token), db)
}
