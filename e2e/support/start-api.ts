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
import { getModelPricingTable } from '@bloombot/config'
import { closeDatabase, openDatabase, runMigrations } from '@bloombot/db'
import { createDiscordRestClient } from '@bloombot/discord-rest'
import { createLogger } from '@bloombot/logger'

import { buildApp } from '../../apps/api/src/server.js'
import { FakeModelClient } from './fake-model-client.js'
import { FileEmailSender } from './file-email-sender.js'
import {
  E2E_API_ORIGIN,
  E2E_API_PORT,
  E2E_ATTACHMENT_STORAGE_DIR,
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
mkdirSync(E2E_ATTACHMENT_STORAGE_DIR, { recursive: true })
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
  // FILE-1..5 — without this, `buildApp`'s own `createPlatformRegistry` call
  // falls through to `./data/attachments`, the repository's own protected
  // directory (`env.js`'s own comment on `E2E_ATTACHMENT_STORAGE_DIR`).
  attachmentStorageDir: E2E_ATTACHMENT_STORAGE_DIR,
  // WEB-10 — `chat.spec.ts`'s own fixed, no-network answer, real Markdown
  // syntax on purpose (a heading and bold text) so that spec can assert the
  // browser actually rendered it rather than showing the literal
  // characters; see `fake-model-client.ts`'s own module comment for what
  // is and is not real in this harness.
  model: new FakeModelClient('# Bloombot\n\nAnswering from a **fixture**.'),
  // COST-1..6 — without this, `deps.pricing` (`@bloombot/core#answer.ts`)
  // is `undefined`, and `answerQuestion` prices every call in this harness
  // at `0` (its own `NO_PRICING_CONFIGURED` fallback, logged as a warning
  // every time it fires) — a gap this harness had already, found while
  // writing `usage-panel.spec.ts` (COST-4): a real conversation's own cost
  // never reached the ledger for *any* spec in this suite, silently. The
  // documented default rates (`@bloombot/config#getModelPricingTable`, no
  // argument), the same table `apps/api/src/index.ts` builds in
  // production from `CONFIG.MODEL_PRICING_JSON` — real pricing, not a
  // fixture, since `FakeModelClient` reports no token usage either way and
  // `computeCost` estimates from the request/answer text's own length
  // regardless of which table prices that estimate.
  pricing: getModelPricingTable(),
  // ADMIN-4 — no bot/worker process runs in this harness (this file's own
  // module comment: one Playwright project at a time, `apps/web` and this
  // process only), so these are loopback, unreachable placeholders, the
  // same device this file already uses for the Discord install flow's own
  // unused URLs just above. `checkPlatformHealth` treats a failed fetch as
  // `{ reachable: false }`, never a thrown error, so the admin console
  // spec still renders — it just sees every process but this one as
  // unreachable, which is honestly what is true in this harness.
  botHealthUrl: 'http://127.0.0.1:1/health',
  workerHealthUrl: 'http://127.0.0.1:1/health',
  apiHealthUrl: `${E2E_API_ORIGIN}/health`,
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
