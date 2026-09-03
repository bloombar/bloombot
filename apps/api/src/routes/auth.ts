/**
 * API-1's own rule applied to sign-in: this file validates nothing beyond
 * "is the request body shaped like the flow expects", authorizes nothing
 * (there is no session to authorize against most of these calls), and
 * writes nothing itself — every flow is `@bloombot/auth`'s own
 * `requestSignInLink`/`redeemSignInLink`/`signInWithGoogle`/`revokeSession`,
 * called here and nowhere else. A thrown error is handed to `next`, never
 * caught and mapped by a route — `middleware/errors.ts` is the one place
 * that happens (API-4).
 */

import { Router } from 'express'
import { z } from 'zod'

import {
  isSameOriginPath,
  redeemSignInLink,
  requestSignInLink,
  revokeSession,
  signInWithGoogle,
  type EmailSender,
  type GoogleIdTokenVerifier,
} from '@bloombot/auth'
import {
  accounts,
  memberships,
  organizations,
  people,
  type Database,
} from '@bloombot/db'

import { clearSessionCookie, setSessionCookie } from '../middleware/session.js'

export interface AuthRouterDependencies {
  db: Database
  /** The mail port a sign-in link is sent through — a real transport in production, `RecordingEmailSender` in a test (`@bloombot/auth`'s own `email.ts`). */
  emailSender: EmailSender
  /** Turns an issued token into the URL the emailed link points at. `@bloombot/auth` has no notion of the web app's own route; this API does. */
  buildSignInLink: (token: string) => string
  googleVerifier: GoogleIdTokenVerifier
}

// Must-fix 3 of the API-1..6 rework: `z.string().min(1)` let a syntactically
// invalid address (a typo, not merely an empty string) reach
// `issueSignInToken`, which validates with its own `z.email()` and throws a
// `ZodError` — a value with no `code`, so `middleware/errors.ts` treated it
// as unexpected and answered `500`. `z.email()` here catches the same
// address at the route boundary instead, where a validation failure is
// already an ordinary `400`.
// AUTH-6: `destination` is optional — a caller with nowhere in particular to
// return to (the ordinary "email me a link" screen) omits it entirely — and,
// when present, must pass `isSameOriginPath` (`@bloombot/auth`'s own
// `tokens.ts`), the identical gate `consumeSignInToken` re-checks on the way
// back out. Refusing a bad one here, the same `400` shape `email` already
// gets, is cheap and immediate — the alternative is discovering it only once
// something tries to navigate a browser there.
const requestLinkInputSchema = z.object({
  email: z.email(),
  destination: z
    .string()
    .refine(isSameOriginPath, 'destination must be a same-origin path')
    .optional(),
})
const redeemInputSchema = z.object({ token: z.string().min(1) })
const googleInputSchema = z.object({ idToken: z.string().min(1) })

export function buildAuthRouter(deps: AuthRouterDependencies): Router {
  const router = Router()

  /** AUTH-1: request a sign-in link. Always the same response whether or not the address has an account — nothing here should let a caller learn which. */
  router.post('/request-link', (req, res, next) => {
    const parsed = requestLinkInputSchema.safeParse(req.body)
    if (!parsed.success) {
      // Field errors, the way `middleware/errors.ts` reports every other
      // input-validation failure (`action_input_invalid`'s own `issues`
      // array) — must-fix 3 of the API-1..6 rework.
      res
        .status(400)
        .json({ error: 'invalid_request', issues: parsed.error.issues })
      return
    }
    requestSignInLink(
      parsed.data.email,
      {
        db: deps.db,
        emailSender: deps.emailSender,
        buildLink: deps.buildSignInLink,
      },
      parsed.data.destination
    )
      .then(() => res.status(204).end())
      .catch(next)
  })

  /** AUTH-1: redeem a sign-in link. `redeemSignInLink` is what rotates the session in effect — a returning account's other sessions are revoked in the same transaction that opens this one (`@bloombot/auth`'s D-19, finding 2), so the old token stops validating the moment this succeeds. */
  router.post('/redeem', (req, res, next) => {
    const parsed = redeemInputSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    try {
      const result = redeemSignInLink(parsed.data.token, deps.db)
      if (!result) {
        res.status(401).json({ error: 'invalid_token' })
        return
      }
      setSessionCookie(res, result.session)
      // AUTH-6 — `result.destination` is already validated
      // (`redeemSignInLink`'s own `consumeSignInToken`, `isSameOriginPath`),
      // and `JSON.stringify` drops an `undefined` property outright, so an
      // ordinary sign-in with nowhere to return to simply omits the field
      // rather than sending it `null`.
      res
        .status(200)
        .json({ accountId: result.account.id, destination: result.destination })
    } catch (error) {
      next(error)
    }
  })

  /** AUTH-2: the Google callback. Verification (signature, issuer, audience, `email_verified`) is entirely `deps.googleVerifier`'s and `signInWithGoogle`'s — this route only wires the two together and sets the cookie the same way `/redeem` does. */
  router.post('/google', (req, res, next) => {
    const parsed = googleInputSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    deps.googleVerifier
      .verifyIdToken(parsed.data.idToken)
      .then((verification) => {
        if (!verification.ok) {
          res.status(401).json({ error: 'invalid_token' })
          return
        }
        const result = signInWithGoogle(verification.identity, deps.db)
        if (!result) {
          res.status(401).json({ error: 'invalid_token' })
          return
        }
        setSessionCookie(res, result.session)
        res.status(200).json({ accountId: result.account.id })
      })
      .catch(next)
  })

  /** AUTH-3: sign out. Revokes the session server-side — `revokeSession` — rather than only clearing the cookie, so a captured cookie value stops validating too, not just stops being sent by this browser. */
  router.post('/sign-out', (req, res, next) => {
    try {
      if (req.sessionToken) revokeSession(req.sessionToken, deps.db)
      clearSessionCookie(res)
      res.status(204).end()
    } catch (error) {
      next(error)
    }
  })

  /**
   * "Who am I" — reports what the session cookie already proved
   * (`middleware/session.ts`), plus the caller's own memberships. `{
   * account: null }` for an anonymous or dead session; never an error,
   * since having no session is not a failure.
   *
   * Must-fix 9 of the API-1..6 rework: every action URL is
   * `POST /organizations/:organizationId/actions/:name`
   * (`routes/actions.ts`) — without the memberships below, a signed-in web
   * client had no way to discover which organization id to put there at
   * all. `memberships.listMembershipsForAccount` is organization-independent
   * for the same documented reason `accounts.getAccountByEmail` is: an
   * account exists across organizations, so nothing here can be scoped to
   * one until this call names it.
   *
   * TEN-7 (D-22's gap 1): each membership also carries the organization's
   * own `name` — `@bloombot/auth`'s `sign-in.ts` already names a personal
   * organization after the account that owns it, but nothing surfaced that
   * name anywhere a caller could read it back, so `OrganizationSwitcher.tsx`
   * (`apps/web`) could only ever show an id. `getOrganizationById` per
   * membership, not a join in `memberships.ts` itself: this route is the
   * one place that needs an organization's name alongside its id, and
   * TEN-2's own convention keeps a repo function scoped to one table's
   * concern rather than reaching across into `organizations` for every
   * caller whether or not it wants a name.
   *
   * `email` (LINK-6): `pages/Connect.tsx` needs to name *the account signed
   * in*, not merely which organizations it belongs to — `accounts.getAccountById`
   * is the one new read this adds, the same unscoped-by-design shape
   * `getAccountByEmail` already is (this file's own module comment), safe
   * here specifically because a valid session already proved this exact
   * account, not a value this route accepts from the caller.
   *
   * `connectedOrganizations` (LINK-10): a membership (TEN-1's
   * administrative relationship) is not the same thing as a connected
   * person (LINK-3's proof) — a student who connects through the Discord
   * invitation is fully reachable *on Discord* the moment they do, but
   * `memberships` alone never named the institution's own organization for
   * them, so the panel's own switcher had nowhere to send them
   * (`docs/DECISIONS.md` D-44's own "Limits", closed here). Sourced from
   * `people.listConnectedOrganizationsForAccount` — the same "which
   * organization ids may this account reach" question `memberships`
   * already answers for the administrative side — and filtered to exclude
   * any organization already present in `memberships`, so the two lists
   * never overlap and the panel does not have to cross-check them itself.
   */
  router.get('/me', (req, res) => {
    if (!req.session) {
      res.status(200).json({ account: null })
      return
    }
    // Unreachable in practice — a session's own foreign key guarantees its
    // account exists — but a session outlives neither, the same
    // "guarded rather than assumed" discipline the organization lookup a
    // few lines below already holds itself to.
    const account = accounts.getAccountById(req.session.accountId, deps.db)
    if (!account) {
      res.status(200).json({ account: null })
      return
    }
    const accountMemberships = memberships.listMembershipsForAccount(
      req.session.accountId,
      deps.db
    )
    const membershipOrganizationIds = new Set(
      accountMemberships.map((membership) => membership.organizationId)
    )
    // LINK-10 — the connected-but-not-a-member organizations, excluding any
    // already reported above as a membership (this route's own doc comment
    // on why the two lists never overlap).
    const connectedOrganizations = people
      .listConnectedOrganizationsForAccount(req.session.accountId, deps.db)
      .filter(
        (connection) =>
          !membershipOrganizationIds.has(connection.organizationId)
      )
      .map((connection) => {
        const organization = organizations.getOrganizationById(
          connection.organizationId,
          deps.db
        )
        return {
          organizationId: connection.organizationId,
          // Unreachable in practice — same fallback, same reason, as the
          // membership mapping below.
          organizationName: organization?.name ?? connection.organizationId,
        }
      })
    res.status(200).json({
      account: {
        id: req.session.accountId,
        email: account.email,
        memberships: accountMemberships.map((membership) => {
          const organization = organizations.getOrganizationById(
            membership.organizationId,
            deps.db
          )
          return {
            organizationId: membership.organizationId,
            // Unreachable in practice — a membership's own foreign key
            // guarantees its organization exists — but a session outlives
            // neither, so this falls back rather than throwing on a race
            // nothing in this codebase causes on purpose.
            organizationName: organization?.name ?? membership.organizationId,
            role: membership.role,
          }
        }),
        connectedOrganizations,
      },
    })
  })

  return router
}
