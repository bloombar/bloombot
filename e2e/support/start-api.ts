/**
 * Starts a real `apps/api` process for the e2e harness (QA-2: "end-to-end
 * tests run the real API ... and a throwaway database") — against a fresh
 * database under `e2e/tmp/` and `FileEmailSender` (this directory's own
 * stand-in — see that file's module comment for why `apps/api`'s own
 * production `LoggingEmailSender` cannot serve this purpose) so
 * `auth-flow.spec.ts` can read a sign-in link back out.
 *
 * Run via `tsx` (`playwright.config.ts`'s `webServer` entry), never
 * `apps/api/src/index.ts` — this reuses `buildApp` directly, the same
 * factory `apps/api/tests/helpers/build-test-app.ts` drives, so this
 * harness needs no change to `apps/api` itself (this slice's brief: "do
 * not change the API's routes").
 */

import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

import { createGoogleIdTokenVerifier } from '@bloombot/auth'
import { closeDatabase, openDatabase, runMigrations } from '@bloombot/db'
import { createDiscordRestClient } from '@bloombot/discord-rest'
import { createLogger } from '@bloombot/logger'

import { buildApp } from '../../apps/api/src/server.js'
import { FileEmailSender } from './file-email-sender.js'
import {
  E2E_API_PORT,
  E2E_DATABASE_PATH,
  E2E_LOGS_DIR,
  E2E_MAIL_PATH,
  E2E_PUBLIC_APP_URL,
} from './env.js'

// A fresh database and a fresh mailbox every run — the previous run's
// sign-in tokens and sessions must not leak into this one's.
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(`${E2E_DATABASE_PATH}${suffix}`, { force: true })
}
mkdirSync(E2E_LOGS_DIR, { recursive: true })
writeFileSync(E2E_MAIL_PATH, '')

const db = openDatabase(E2E_DATABASE_PATH)
runMigrations(db)

const logger = createLogger('e2e-api', { logsDir: E2E_LOGS_DIR })

const app = buildApp({
  db,
  logger,
  publicAppUrl: E2E_PUBLIC_APP_URL,
  emailSender: new FileEmailSender(E2E_MAIL_PATH),
  buildSignInLink: (token) => `${E2E_PUBLIC_APP_URL}/sign-in/${token}`,
  // Never called in this slice's e2e spec (Google sign-in and the Discord
  // install flow are both out of scope for QA-7's own "sign in, land in an
  // organization, see what a signed-in instructor sees") — real, lazy
  // factories (PLAT-5: no network at construction), the same ones
  // `apps/api/src/index.ts` itself builds in production.
  googleVerifier: createGoogleIdTokenVerifier(),
  discordRestClient: createDiscordRestClient({
    clientId: 'e2e-unused-client-id',
    clientSecret: 'e2e-unused-client-secret',
    // Loopback, unreachable placeholders (`No network beyond loopback`)
    // rather than the real Discord hosts `CONFIG`'s own defaults would
    // otherwise supply — inert either way, since nothing in this spec
    // exercises the install flow, but this way a bug that *did* reach them
    // fails fast instead of reaching discord.com.
    apiBase: 'http://127.0.0.1:1/discord-api-unused',
    oauthBase: 'http://127.0.0.1:1/discord-oauth-unused',
  }),
  discordClientId: 'e2e-unused-client-id',
  discordBotToken: 'e2e-unused-bot-token',
  discordRedirectUri: `${E2E_PUBLIC_APP_URL}/discord/callback`,
  discordOauthBase: 'http://127.0.0.1:1/discord-oauth-unused',
})

const server = createServer(app)
server.listen(E2E_API_PORT, '127.0.0.1', () => {
  console.log(`e2e: apps/api listening on ${E2E_API_PORT}`)
})

function shutdown(): void {
  server.close(() => {
    closeDatabase(db)
    process.exit(0)
  })
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
