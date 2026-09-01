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
  redeemSignInLink,
  requestSignInLink,
  revokeSession,
  signInWithGoogle,
  type EmailSender,
  type GoogleIdTokenVerifier,
} from '@bloombot/auth'
import type { Database } from '@bloombot/db'

import { clearSessionCookie, setSessionCookie } from '../middleware/session.js'

export interface AuthRouterDependencies {
  db: Database
  /** The mail port a sign-in link is sent through — a real transport in production, `RecordingEmailSender` in a test (`@bloombot/auth`'s own `email.ts`). */
  emailSender: EmailSender
  /** Turns an issued token into the URL the emailed link points at. `@bloombot/auth` has no notion of the web app's own route; this API does. */
  buildSignInLink: (token: string) => string
  googleVerifier: GoogleIdTokenVerifier
}

const requestLinkInputSchema = z.object({ email: z.string().min(1) })
const redeemInputSchema = z.object({ token: z.string().min(1) })
const googleInputSchema = z.object({ idToken: z.string().min(1) })

export function buildAuthRouter(deps: AuthRouterDependencies): Router {
  const router = Router()

  /** AUTH-1: request a sign-in link. Always the same response whether or not the address has an account — nothing here should let a caller learn which. */
  router.post('/request-link', (req, res, next) => {
    const parsed = requestLinkInputSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' })
      return
    }
    requestSignInLink(parsed.data.email, {
      db: deps.db,
      emailSender: deps.emailSender,
      buildLink: deps.buildSignInLink,
    })
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
      res.status(200).json({ accountId: result.account.id })
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

  /** "Who am I" — reports exactly what the session cookie already proved (`middleware/session.ts`), nothing looked up beyond it. `{ account: null }` for an anonymous or dead session; never an error, since having no session is not a failure. */
  router.get('/me', (req, res) => {
    if (!req.session) {
      res.status(200).json({ account: null })
      return
    }
    res.status(200).json({ account: { id: req.session.accountId } })
  })

  return router
}
