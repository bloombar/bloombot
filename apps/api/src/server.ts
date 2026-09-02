/**
 * Builds the Express app (PLAT-5 / API-1): a function returning the app,
 * every dependency passed in rather than reached for at import time, so a
 * test drives it with `supertest` and no port is ever bound just to run a
 * suite. `src/index.ts` is the only caller that actually listens.
 *
 * Middleware order is load-bearing:
 *   1. `express.json()`, twice — parse the body before anything reads it.
 *      The actions mount gets its own `express.json({ limit: ACTION_JSON_BODY_LIMIT_BYTES })`
 *      *first*, so a `courseAttachments.attach` payload (base64 file bytes
 *      in the JSON body, `routes/actions.ts`'s own doc comment on
 *      `ACTION_JSON_BODY_LIMIT_BYTES`) is not held to `express.json()`'s
 *      ordinary 100 kB default — body-parser skips re-parsing a body it
 *      already parsed, so the second, general-purpose `express.json()`
 *      below is a no-op for that one path prefix and the ordinary default
 *      for every other route.
 *   2. `originCheck` (API-3) — before the session is even read: a refused
 *      request never reaches `sessionMiddleware`, let alone a route.
 *   3. `sessionMiddleware` (API-2) — attaches `req.session`, or not.
 *   4. The routes themselves (API-1) — `routes/auth.ts`, `routes/actions.ts`,
 *      `routes/discord-servers.ts` (TEN-4), `routes/chat.ts` (WEB-10), and
 *      this process's own `GET /health` (API-6).
 *   5. `errorMiddleware` (API-4 / ACT-4) — last, so every thrown error from
 *      every route above lands here and nowhere else.
 */

import express, { type Express } from 'express'

import { createPlatformRegistry, type ActionRegistry } from '@bloombot/actions'
import type { EmailSender, GoogleIdTokenVerifier } from '@bloombot/auth'
import type { ModelClient, PricingTable } from '@bloombot/core'
import { createFilesystemAttachmentStorage, type Database } from '@bloombot/db'
import type { DiscordRestClient } from '@bloombot/discord-rest'
import type { AdmissionGate } from '@bloombot/jobs'
import type { Logger } from '@bloombot/logger'

import { checkHealth } from './health.js'
import { errorMiddleware } from './middleware/errors.js'
import { originCheck } from './middleware/origin.js'
import { sessionMiddleware } from './middleware/session.js'
import {
  ACTION_JSON_BODY_LIMIT_BYTES,
  buildActionsRouter,
} from './routes/actions.js'
import { buildAdminRouter } from './routes/admin.js'
import { buildAuthRouter } from './routes/auth.js'
import { buildChatRouter } from './routes/chat.js'
import { buildDiscordServersRouter } from './routes/discord-servers.js'
import {
  buildPersonLinkRouter,
  type PendingDiscordConnect,
} from './routes/person-link.js'
import { buildTranscriptExportsRouter } from './routes/transcript-exports.js'

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
  /** FILE-1..5 — where a course attachment's own bytes are written; threaded to `createPlatformRegistry` when `registry` above is not itself overridden. `src/index.ts` always supplies `CONFIG.ATTACHMENT_STORAGE_DIR` explicitly, the same as every other `CONFIG` value it reads once and passes down — omitting this is only ever a test's own choice, and falls through to `createPlatformRegistry`'s own `'./tmp/attachments'` default (never `data/`, a rework finding — see `docs/DECISIONS.md` D-32). */
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
  /** WEB-10 — the model port `routes/chat.ts` calls `answerQuestion` with, the same "dependency, not an import" seam `packages/core` itself already demands (CORE-4). The real OpenAI adapter in production (`src/index.ts`, mirroring `apps/bot`'s own `main()`); a `FakeModelClient` in every test. */
  model: ModelClient
  /** JOB-4's bound on concurrent model calls, threaded through to `routes/chat.ts` exactly the way `apps/bot`'s own `main()` threads it to `handleMention` — omitted, this app's chat route applies `answerQuestion`'s own no-bound default (see that file's module comment). */
  admission?: AdmissionGate
  /** COST-1/COST-6's per-model rates, threaded through the same way — omitted, `answerQuestion` prices every call at its own zero-rate default and logs a warning each time (see that file's own `NO_PRICING_CONFIGURED` comment). */
  pricing?: PricingTable
  /** ADMIN-4/COST-5 — where `routes/admin.ts` reaches each process's own loopback health endpoint. `CONFIG.BOT_HEALTH_PORT`/`WORKER_HEALTH_PORT`/`API_PORT` on `127.0.0.1` in production (`src/index.ts`, mirroring `docs/DECISIONS.md` D-33's own accounting of who has to know these three ports). Required, the same way `discordOauthBase` is — a test supplies its own fixed (unreachable, or faked via `adminHealthFetch`) URLs rather than this file inventing a default port nothing configured. */
  botHealthUrl: string
  workerHealthUrl: string
  apiHealthUrl: string
  /** Overridable so a test can fake the three processes' health responses with no real network — `checkPlatformHealth`'s own `fetchFn` option, threaded through `routes/admin.ts`. */
  adminHealthFetch?: typeof fetch
  /** LINK-6/7 — `routes/person-link.ts`'s own in-memory record of an in-flight Discord connect attempt (D-44's own session-binding rework). Injectable so a test can seed or inspect one directly; ordinary callers (`src/index.ts`) never set this and get a fresh `Map` per `buildApp` call. */
  pendingDiscordConnects?: Map<string, PendingDiscordConnect>
}

export function buildApp(deps: ServerDependencies): Express {
  const registry =
    deps.registry ??
    createPlatformRegistry({
      ...(deps.attachmentStorageDir !== undefined
        ? { attachmentStorageDir: deps.attachmentStorageDir }
        : {}),
    })
  // ADMIN-3/ADMIN-5 — a second `AttachmentStorage` instance over the same
  // directory `createPlatformRegistry` above already builds one against:
  // the port is stateless (a plain filesystem path, `attachment-storage.ts`'s
  // own doc comment), so two instances pointed at the same root are
  // functionally identical, and this file has no way to reach inside
  // `registry`'s own closure to reuse the one it built. Never `data/` — the
  // same `'./tmp/attachments'` fallback `createPlatformRegistry` itself
  // uses (D-32).
  const attachmentStorage = createFilesystemAttachmentStorage(
    deps.attachmentStorageDir ?? './tmp/attachments'
  )

  const app = express()
  // Not itself a SPEC requirement, but the header discloses this is an
  // Express app for free — the same reasoning `apps/bot`'s own health
  // server binds to loopback only rather than trusting nobody asks.
  app.disable('x-powered-by')

  // FILE-1 — mounted before the general-purpose `express.json()` below, and
  // only for this one path prefix: see this file's own module comment
  // ("Middleware order is load-bearing") and `routes/actions.ts`'s own doc
  // comment on `ACTION_JSON_BODY_LIMIT_BYTES` for why a `courseAttachments.attach`
  // payload needs a limit well above the ordinary default.
  app.use(
    '/organizations/:organizationId/actions',
    express.json({ limit: ACTION_JSON_BODY_LIMIT_BYTES })
  )
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
    '/organizations/:organizationId/chat',
    buildChatRouter({
      db: deps.db,
      logger: deps.logger,
      model: deps.model,
      ...(deps.admission ? { admission: deps.admission } : {}),
      ...(deps.pricing ? { pricing: deps.pricing } : {}),
    })
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
  app.use(
    '/organizations/:organizationId/transcript-exports',
    buildTranscriptExportsRouter({ db: deps.db, attachmentStorage })
  )
  app.use(
    '/organizations/:organizationId/person-link',
    buildPersonLinkRouter({
      db: deps.db,
      logger: deps.logger,
      discordRestClient: deps.discordRestClient,
      discordClientId: deps.discordClientId,
      // Reuses the install flow's own redirect URI — see
      // `routes/person-link.ts`'s own module comment for why the two flows
      // share one physical page.
      discordRedirectUri: deps.discordRedirectUri,
      discordOauthBase: deps.discordOauthBase,
      ...(deps.pendingDiscordConnects
        ? { pendingDiscordConnects: deps.pendingDiscordConnects }
        : {}),
    })
  )
  // ADMIN-4/ADMIN-5 — mounted at `/admin`, not under
  // `/organizations/:organizationId/...` (`routes/admin.ts`'s own module
  // comment has why).
  app.use(
    '/admin',
    buildAdminRouter({
      db: deps.db,
      logger: deps.logger,
      attachmentStorage,
      botHealthUrl: deps.botHealthUrl,
      workerHealthUrl: deps.workerHealthUrl,
      apiHealthUrl: deps.apiHealthUrl,
      ...(deps.adminHealthFetch ? { fetchFn: deps.adminHealthFetch } : {}),
    })
  )

  // Must be registered last — Express identifies an error handler by its
  // four-parameter signature, and only calls the first one that matches
  // for a given error, so anything mounted after this would never run for
  // a request that already failed.
  app.use(errorMiddleware(deps.logger))

  return app
}
