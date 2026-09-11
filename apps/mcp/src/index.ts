/**
 * apps/mcp — the MCP server (MCP-1..5, PLAT-3, PLAT-4).
 *
 * Thin on purpose, the same shape `apps/api`'s and `apps/bot`'s own module
 * comments describe for themselves: `server.ts` carries every rule about
 * what an assistant may reach and how a destructive call is confirmed, and
 * this file's own job is wiring it to a database connection and an HTTP
 * listener, then shutting down cleanly.
 */

import { createServer } from 'node:http'

import { createPlatformRegistry } from '@bloombot/actions'
import { CONFIG, getModelPricingTable, loadDotEnv } from '@bloombot/config'
import type { ModelClient } from '@bloombot/core'
import {
  closeDatabase,
  openDatabase,
  runMigrations,
  type Database,
} from '@bloombot/db'
import { createAdmissionGate } from '@bloombot/jobs'
import { createLogger, type Logger } from '@bloombot/logger'
import { createOpenAiModelClient } from '@bloombot/openai'

import { buildOauthProvider } from './oauth-provider.js'
import { buildApp } from './server.js'
import { createShutdown } from './shutdown.js'
import { buildToolDefinitions } from './tool-surface.js'

/**
 * MCP-8 — `chat.ask` needs a `ModelClient` no matter what, but
 * `OPENAI_API_KEY` being unset must not stop this whole process from
 * starting: the identical reasoning `apps/api/src/index.ts`'s own
 * `createUnconfiguredModelClient` doc comment gives, duplicated here rather
 * than imported across the app/app boundary this repo does not cross for a
 * five-line stand-in neither app owns. `answerQuestion`'s own
 * `failed-with-apology` outcome (`packages/core/src/answer.ts`) is what a
 * caller of `chat.ask` sees instead of a broken deployment.
 */
function createUnconfiguredModelClient(): ModelClient {
  return {
    ask: () =>
      Promise.reject(new Error('apps/mcp: OPENAI_API_KEY is not configured')),
  }
}

const PROCESS_NAME = 'mcp'

async function main(): Promise<void> {
  // CFG-5: credentials live in `.env`; load it before anything reads CONFIG,
  // which validates the whole environment on first access.
  loadDotEnv()

  // Refuses to start on an environment that does not validate — the same
  // "touch CONFIG before building anything" discipline `apps/api`/`apps/bot`
  // already hold themselves to.
  const logsDir = CONFIG.LOGS_DIR
  const databasePath = CONFIG.DATABASE_PATH
  const port = CONFIG.MCP_PORT
  // FILE-1..5 — the same directory `apps/api`/`apps/worker` already share
  // for a course attachment's own bytes (D-2: one filesystem). No tool in
  // this slice's own allowlist (`tool-surface.ts`) actually reaches
  // `courseAttachments.attach`, but `createPlatformRegistry` still builds
  // the action (every process registers the whole catalog; the allowlist
  // is what decides what is reachable, not what is registered — MCP-2's
  // own module comment).
  const attachmentStorageDir = CONFIG.ATTACHMENT_STORAGE_DIR
  // MCP-7 — `env.ts`'s own doc comment on why this is optional and what
  // falls back when it is not set: a real deployment that wants a client
  // outside this machine to discover this server's OAuth metadata sets
  // this once nginx actually proxies `MCP_PORT` publicly; the loopback
  // fallback is a real, working issuer for local development, where no
  // such client exists to discover it anyway.
  const issuerUrl = new URL(CONFIG.PUBLIC_MCP_URL ?? `http://127.0.0.1:${port}`)
  // MCP-8 — the same three answering seams `apps/api`'s and `apps/bot`'s own
  // `main()` build for `@bloombot/core#answerQuestion`, read once here
  // alongside every other `CONFIG` value this process reads at startup
  // (`ServerDependencies`'s own doc comment on why `chat.ask` needs them).
  const admissionLimit = CONFIG.MODEL_ADMISSION_LIMIT
  const admissionWaitMs = CONFIG.MODEL_ADMISSION_WAIT_MS
  // Not `requireEnv` — `createUnconfiguredModelClient`'s own doc comment
  // just above has why a missing key degrades `chat.ask` rather than
  // stopping this whole process from starting.
  const openaiApiKey = process.env['OPENAI_API_KEY']

  const logger: Logger = createLogger(PROCESS_NAME, { logsDir })
  const db: Database = openDatabase(databasePath)
  runMigrations(db)

  const registry = createPlatformRegistry({ attachmentStorageDir })
  // Built once, here, before this process ever accepts a request — not
  // lazily on the first session. `buildToolDefinitions` throws if the
  // allowlist (`tool-surface.ts#MCP_TOOL_SURFACE`) names an action that is
  // not registered, or a destructive one with no `describeTarget`; calling
  // it here means that failure happens before `server.listen` below, so a
  // supervisor (OPS-8) or a liveness probe never sees a process that
  // reports healthy while its whole tool surface is actually dead — a
  // rework finding: this call used to happen lazily, per session, inside
  // `server.ts`'s own request handler, so a stale allowlist entry crashed
  // the *first real session* with a `500` and a healthy-looking `/health`
  // moments earlier, instead of failing this process's own startup.
  const toolDefinitions = buildToolDefinitions(registry)
  // Rework finding — `/health` used to keep reporting `ready: true` for
  // this process's whole teardown window; `shuttingDown` is flipped by
  // `shutdown` below and read fresh by `server.ts`'s own `/health` route
  // on every request, the same `apps/bot`/`apps/worker` own pattern
  // (`gatewayConnected`/`workerHealthStatus`) for the same reason.
  let shuttingDown = false
  // MCP-7 — `${PUBLIC_APP_URL}/oauth/mcp/authorize` (`apps/api`'s own
  // consent route, mounted there rather than here — that route's own
  // module comment on why the human-facing half of this flow lives in
  // `apps/api`, not `apps/mcp`).
  const oauthProvider = buildOauthProvider({
    db,
    consentUrl: `${CONFIG.PUBLIC_APP_URL}/oauth/mcp/authorize`,
    resource: new URL('/mcp', issuerUrl).toString(),
  })
  if (!openaiApiKey) {
    logger.warn(
      {},
      'apps/mcp: OPENAI_API_KEY is not set — chat.ask will apologize to every question until it is configured'
    )
  }
  const model = openaiApiKey
    ? createOpenAiModelClient({ apiKey: openaiApiKey, logger })
    : createUnconfiguredModelClient()
  const admission = createAdmissionGate({
    limit: admissionLimit,
    waitMs: admissionWaitMs,
  })
  const pricing = getModelPricingTable(CONFIG.MODEL_PRICING_JSON)
  const app = buildApp(
    {
      db,
      logger,
      toolDefinitions,
      oauthProvider,
      issuerUrl,
      model,
      admission,
      pricing,
    },
    undefined,
    () => shuttingDown
  )

  const server = createServer(app)

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      const reason =
        error.code === 'EADDRINUSE'
          ? `port ${port} is already in use — is another instance of this process already running? (PLAT-4)`
          : error.message
      reject(new Error(`apps/mcp: could not start the server: ${reason}`))
    })
    // Bound to `127.0.0.1` only, the same reason `apps/api`'s own module
    // comment gives its equally sensitive endpoint: nothing here needs to
    // be reachable from outside the machine it runs on, and PLAT-4 puts
    // nginx in front of whatever does need to reach it remotely.
    server.listen(port, '127.0.0.1', () => {
      logger.info(
        { port, tools: toolDefinitions.length },
        'apps/mcp: listening'
      )
      resolve()
    })
  })

  // Closes the server and the database rather than exiting under load; a
  // second signal is a no-op rather than a second teardown racing the
  // first (`shutdown.ts`'s own module comment).
  const shutdown = createShutdown({
    logger,
    setShuttingDown: () => {
      shuttingDown = true
    },
    closeServer: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
    closeDb: () => closeDatabase(db),
  })
  const onSignal = (signal: string) => {
    shutdown(signal).then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error(
          { err: error, signal },
          'apps/mcp: failed to shut down cleanly'
        )
        process.exit(1)
      }
    )
  }
  process.once('SIGINT', () => onSignal('SIGINT'))
  process.once('SIGTERM', () => onSignal('SIGTERM'))
}

main().catch((error: unknown) => {
  // No logger may exist yet if `main` failed before `createLogger` ran (a
  // bad environment) — stderr is the only sink guaranteed to work, the same
  // fallback every other process's own entry point uses.
  console.error('apps/mcp: failed to start', error)
  process.exit(1)
})
