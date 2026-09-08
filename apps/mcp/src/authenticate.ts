/**
 * MCP-3: a connection authenticates as an account and carries that
 * account's memberships and nothing more.
 *
 * Reuses AUTH-3's own session tokens (`@bloombot/auth`'s `validateSession`)
 * as the bearer credential — the same token the web panel already carries
 * in a cookie (`apps/api`'s own `sessionMiddleware`) — rather than
 * inventing a second credential type for this surface. There is
 * deliberately no other way in: no service credential, no API key scoped to
 * an organization rather than an account. Minting a token specifically to
 * hand to an assistant (a "connect an assistant" screen in the panel) is
 * `apps/web`'s own future work, out of this slice's scope — this module
 * only validates whatever bearer token arrives, the same way
 * `sessionMiddleware` only validates whatever cookie arrives.
 *
 * Memberships are deliberately *not* fetched and cached here: `call-tool.ts`
 * looks up the caller's membership in the one organization a given call
 * names, fresh, on every call (`memberships.getMembership`) — the same
 * "read the database, not a snapshot of it" discipline every other policy
 * in this platform already holds itself to. A membership revoked mid-session
 * stops granting access on the very next tool call, not merely the next
 * reconnect.
 */

import { validateSession } from '@bloombot/auth'
import type { Database } from '@bloombot/db'

/** `Authorization: Bearer <token>` — the one header this surface reads for a credential. `undefined` for anything else (no header, a different scheme, no token after `Bearer`). */
export function parseBearerToken(
  header: string | undefined
): string | undefined {
  if (!header) return undefined
  const match = /^Bearer\s+(\S+)$/i.exec(header)
  return match?.[1]
}

/**
 * Validates a bearer token the same way `apps/api`'s own session cookie is
 * validated. `undefined` for a token that does not validate — deliberately
 * the same shape a missing cookie gives `apps/api`'s `req.session`, not a
 * distinguishable error: a caller probing tokens must not be able to tell
 * "wrong" from "expired" from "revoked" apart (AUTH-3's own guarantee,
 * unchanged by which surface reads the token).
 */
export function authenticateBearerToken(
  token: string | undefined,
  db: Database
): string | undefined {
  if (!token) return undefined
  const session = validateSession(token, db)
  return session?.accountId
}
