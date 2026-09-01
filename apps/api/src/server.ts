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
 *      `routes/discord-servers.ts` (TEN-4), and this process's own
 *      `GET /health` (API-6).
 *   5. `errorMiddleware` (API-4 / ACT-4) — last, so every thrown error from
 *      every route above lands here and nowhere else.
 */

import express, { type Express } from 'express'

import { createPlatformRegistry, type ActionRegistry } from '@bloombot/actions'
import type { EmailSender, GoogleIdTokenVerifier } from '@bloombot/auth'
import type { Database } from '@bloombot/db'
import type { DiscordRestClient } from '@bloombot/discord-rest'
import type { Logger } from '@bloombot/logger'

import { checkHealth } from './health.js'
import { errorMiddleware } from './middleware/errors.js'
import { originCheck } from './middleware/origin.js'
import { sessionMiddleware } from './middleware/session.js'
import { buildActionsRouter } from './routes/actions.js'
import { buildAuthRouter } from './routes/auth.js'
import { buildDiscordServersRouter } from './routes/discord-servers.js'

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
  /** FILE-1..5 — where a course attachment's own bytes are written; threaded to `createPlatformRegistry` when `registry` above is not itself overridden. Defaults to `AttachmentStorage`'s own default (`CONFIG.ATTACHMENT_STORAGE_DIR`) when omitted, the same as every other `CONFIG` value this file's own caller (`src/index.ts`) reads once and passes down. */
  attachmentStorageDir?: string
  /** TEN-4's install flow — the real Discord REST client in production, a loopback fake in a test (`@bloombot/discord-rest`'s port). */
  discordRestClient: DiscordRestClient
  /** Discord's "client id"/"application id" — `BOT_APP_ID` in env.example. */
  discordClientId: string
  /** The bot's own token — `BOT_TOKEN` in env.example, the same credential `apps/bot` logs in with (API-5: "reaches Discord over REST with the same token"). Used only for `getBotGuilds`; never persisted, never logged. */
  discordBotToken: string
  /** Bot permission integer for the authorize URL's `permissions` param — `BOT_PERMISSIONS` in env.example. Omitted from the URL entirely when unset. */
  discordPermissions?: string
  /** Must exactly match a redirect URI registered with the Discord application — `${publicAppUrl}/discord/callback` in production. */
  discordRedirectUri: string
  /** `CONFIG.DISCORD_OAUTH_BASE`, read once in `src/index.ts` — see `routes/discord-servers.ts`'s own doc comment on why this is passed in rather than read lazily inside that router. */
  discordOauthBase: string
}

export function buildApp(deps: ServerDependencies): Express {
  const registry =
    deps.registry ??
    createPlatformRegistry({
      ...(deps.attachmentStorageDir !== undefined
        ? { attachmentStorageDir: deps.attachmentStorageDir }
        : {}),
    })

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
  app.use(
    '/organizations/:organizationId/discord-servers',
    buildDiscordServersRouter({
      db: deps.db,
      logger: deps.logger,
      discordRestClient: deps.discordRestClient,
      discordClientId: deps.discordClientId,
      discordBotToken: deps.discordBotToken,
      discordRedirectUri: deps.discordRedirectUri,
      discordOauthBase: deps.discordOauthBase,
      ...(deps.discordPermissions
        ? { discordPermissions: deps.discordPermissions }
        : {}),
    })
  )

  // Must be registered last — Express identifies an error handler by its
  // four-parameter signature, and only calls the first one that matches
  // for a given error, so anything mounted after this would never run for
  // a request that already failed.
  app.use(errorMiddleware(deps.logger))

  return app
}
