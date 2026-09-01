/**
 * Builds the Express app (PLAT-5 / API-1): a function returning the app,
 * every dependency passed in rather than reached for at import time, so a
 * test drives it with `supertest` and no port is ever bound just to run a
 * suite. `src/index.ts` is the only caller that actually listens.
 *
 * Middleware order is load-bearing:
 *   1. `express.json()` — parse the body before anything reads it.
 *   2. `originCheck` (API-3) — before the session is even read: a refused
 *      request never reaches `sessionMiddleware`, let alone a route.
 *   3. `sessionMiddleware` (API-2) — attaches `req.session`, or not.
 *   4. The routes themselves (API-1) — `routes/auth.ts`, `routes/actions.ts`,
 *      and this process's own `GET /health` (API-6).
 *   5. `errorMiddleware` (API-4 / ACT-4) — last, so every thrown error from
 *      every route above lands here and nowhere else.
 */

import express, { type Express } from 'express'

import { createPlatformRegistry, type ActionRegistry } from '@bloombot/actions'
import type { EmailSender, GoogleIdTokenVerifier } from '@bloombot/auth'
import type { Database } from '@bloombot/db'
import type { Logger } from '@bloombot/logger'

import { checkHealth } from './health.js'
import { errorMiddleware } from './middleware/errors.js'
import { originCheck } from './middleware/origin.js'
import { sessionMiddleware } from './middleware/session.js'
import { buildActionsRouter } from './routes/actions.js'
import { buildAuthRouter } from './routes/auth.js'

export interface ServerDependencies {
  db: Database
  logger: Logger
  /** Checked against every non-GET request's `Origin`/`Referer` (API-3). `CONFIG.PUBLIC_APP_URL` in production. */
  publicAppUrl: string
  emailSender: EmailSender
  buildSignInLink: (token: string) => string
  googleVerifier: GoogleIdTokenVerifier
  /** Defaults to `createPlatformRegistry()` — every action this slice ports. Overridable so a test can dispatch against a registry of its own, e.g. a recording action, without registering it alongside the platform's real ones. */
  registry?: ActionRegistry
}

export function buildApp(deps: ServerDependencies): Express {
  const registry = deps.registry ?? createPlatformRegistry()

  const app = express()
  // Not itself a SPEC requirement, but the header discloses this is an
  // Express app for free — the same reasoning `apps/bot`'s own health
  // server binds to loopback only rather than trusting nobody asks.
  app.disable('x-powered-by')

  app.use(express.json())
  app.use(originCheck(deps.publicAppUrl))
  app.use(sessionMiddleware(deps.db))

  app.get('/health', (_req, res) => {
    const status = checkHealth(deps.db)
    res.status(status.ready ? 200 : 503).json(status)
  })

  app.use(
    '/auth',
    buildAuthRouter({
      db: deps.db,
      emailSender: deps.emailSender,
      buildSignInLink: deps.buildSignInLink,
      googleVerifier: deps.googleVerifier,
    })
  )
  app.use(
    '/organizations/:organizationId/actions',
    buildActionsRouter(registry, deps.db)
  )

  // Must be registered last — Express identifies an error handler by its
  // four-parameter signature, and only calls the first one that matches
  // for a given error, so anything mounted after this would never run for
  // a request that already failed.
  app.use(errorMiddleware(deps.logger))

  return app
}
