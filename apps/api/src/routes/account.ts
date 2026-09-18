/**
 * WEB-72/DATA-7 — an account holder deletes their own account. Mounted at
 * `/account`, unscoped by `:organizationId`, the same reason `/auth`
 * (`routes/auth.ts`'s own module comment), `/join-links` (ENRL-8) and
 * `/membership-invitations` (ENRL-10) all are: a signed-in caller acting on
 * their *own account* is not "acting within" any one organization, so this
 * does not belong under `/organizations/:organizationId/actions`
 * (`routes/actions.ts`'s own dispatch always resolves the caller's
 * organization from a membership, which a self-account delete has no
 * reason to name — `@bloombot/actions`'s `policy.ts` gives every policy's
 * `resolve` an `organizationId`, and nothing here has one to give it).
 *
 * Soft-deleted (`@bloombot/db`'s `accounts.ts#softDeleteAccount`'s own doc
 * comment) — reversible for the deployment's retention window, then
 * permanent once DATA-8's sweep runs. Unlike a course, a project or an
 * organization, deleting an account is never gated behind a role check:
 * every account holder may always delete their own account, the same
 * "who may act" question `routes/auth.ts#sign-out` never asks either.
 *
 * **Ends every session belonging to this account, not only this browser's
 * cookie** — `sessions.revokeAllSessionsForAccount`, the identical call
 * `@bloombot/db`'s `accounts.ts#disableAccount` already makes for the same
 * reason, then `clearSessionCookie` so this response's own browser stops
 * sending a now-revoked token. `softDeleteAccount` itself deliberately
 * leaves ending a session to its caller (that function's own doc comment)
 * — this route is that caller, and the account being deleted is the very
 * one this session belongs to, so there is exactly one session set to
 * revoke: every one this account holds.
 */

import { Router } from 'express'

import { accounts, sessions, type Database } from '@bloombot/db'

import { clearSessionCookie } from '../middleware/session.js'

export interface AccountRouterDependencies {
  db: Database
}

export function buildAccountRouter(deps: AccountRouterDependencies): Router {
  const router = Router()

  /**
   * Delete the signed-in account. No input beyond the session itself — the
   * account acted on is always the caller's own, never one named in the
   * request body (the same "never read out of the request, only the
   * session" discipline every write in this codebase already holds an
   * actor id to).
   */
  router.post('/delete', (req, res) => {
    if (!req.session) {
      res.status(401).json({ error: 'not_signed_in' })
      return
    }
    const accountId = req.session.accountId

    const deleted = accounts.softDeleteAccount(accountId, accountId, deps.db)
    if (!deleted) {
      // Unreachable in practice — a valid session names a real, live
      // account — but guarded rather than assumed, the same TEN-2-style
      // race every other write in this codebase already guards against.
      res.status(404).json({ error: 'account_not_found' })
      return
    }

    sessions.revokeAllSessionsForAccount(accountId, deps.db)
    clearSessionCookie(res)
    res.status(204).end()
  })

  return router
}
