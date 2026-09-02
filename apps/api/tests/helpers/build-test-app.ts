/**
 * Test helper: `buildApp` with every dependency defaulted to something a
 * test can run against with no network — a real throwaway database, a
 * recording mail port, a fake Google verifier, and a fixed `publicAppUrl`
 * every origin-check test compares against. A test overrides only the one
 * field its own scenario needs.
 *
 * `buildTestApp` hands back a *listening* `http.Server`, not the bare
 * Express app, and does the listening itself — see `startTestServer`
 * below for why, and for who closes it.
 */

import { createServer, type Server } from 'node:http'
import { join } from 'node:path'

import type {
  GoogleIdTokenVerificationResult,
  GoogleIdTokenVerifier,
} from '@bloombot/auth'
import { RecordingEmailSender } from '@bloombot/auth'
import type { Database } from '@bloombot/db'
import type { Express } from 'express'
import { afterEach } from 'vitest'

import { buildApp, type ServerDependencies } from '../../src/server.js'
import { createFakeDiscordRestClient } from './fake-discord-rest-client.js'
import { createFakeLogger } from './fake-logger.js'
import { FakeModelClient } from './fake-model-client.js'

/** The origin every origin-check test treats as "this site" — never a real host, since nothing here reaches the network. */
export const TEST_PUBLIC_APP_URL = 'https://app.bloombot.test'

// FILE-1..5 — a rework finding: this helper used to omit `attachmentStorageDir`
// entirely, which let `buildApp`'s own `createPlatformRegistry` call fall
// through to its default (`packages/actions/src/actions/index.ts`) — a
// literal that used to be `./data/attachments`, the repository's own
// protected directory. Threaded explicitly here instead, under `tmp/`, the
// same "lives under `tmp/`, never `data/`" discipline `test-db.ts`'s own
// module comment already holds `TestDatabase` to.
export const TEST_ATTACHMENT_STORAGE_DIR = join(
  process.cwd(),
  'tmp',
  'api-tests',
  'attachments'
)

/** A `GoogleIdTokenVerifier` that never reaches a network — always refuses, unless a test replaces `verifyIdToken` with its own. */
export function createFakeGoogleVerifier(
  result: GoogleIdTokenVerificationResult = {
    ok: false,
    reason: 'fake verifier: no token configured to verify',
  }
): GoogleIdTokenVerifier {
  return {
    verifyIdToken: () => Promise.resolve(result),
  }
}

// Every server `startTestServer` opens is tracked here so a test file never
// has to remember to close it itself — the single `afterEach` below closes
// whatever this file's tests opened, every time. Forgetting this leaks a
// listening socket per test; enough of those in one run runs the suite out
// of file descriptors (`EMFILE`) long before it ever gets to the bug this
// helper actually exists to avoid.
const openServers = new Set<Server>()

afterEach(async () => {
  await Promise.all(Array.from(openServers, closeTestServer))
  openServers.clear()
})

function closeTestServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
}

/**
 * Starts `app` listening on loopback and resolves once it actually is.
 *
 * `supertest`'s own `Test#serverAddress` (`supertest/lib/test.js`) calls
 * `app.listen(0)` with no host when handed a bare Express app, which binds
 * the IPv6 wildcard `::` — then dials the hard-coded literal
 * `http://127.0.0.1:<port>`. With `SO_REUSEADDR`, the OS is free to hand
 * that wildcard listen an ephemeral port some *other* process already has
 * bound specifically to `127.0.0.1` (this machine runs plenty — VS Code's
 * helper sockets, `vite`'s own dev server), and the more specific binding
 * wins the connection: the request never reaches this app, and whatever
 * that other process answers gets parsed as if it had. Binding to
 * `127.0.0.1` ourselves, before handing supertest an already-listening
 * server, closes that hole — supertest reads the address off a server it
 * did not create instead of picking one itself.
 *
 * This must be awaited: `listen(0, '127.0.0.1')` runs `dns.lookup` even
 * for an IP literal, so it is asynchronous regardless — `server.address()`
 * is still `null` immediately after a synchronous-looking call. There is
 * no way to make a bare Express app "already listening" without an
 * `await` somewhere, which is why `buildTestApp` itself is async.
 *
 * Exported separately from `buildTestApp` so this helper's own regression
 * test can force a specific, already-occupied port and prove the bind
 * fails loudly (`EADDRINUSE`) instead of silently landing on whatever else
 * is squatting there — the property that makes this whole class of bug
 * impossible rather than merely rare.
 */
export function startTestServer(app: Express, port = 0): Promise<Server> {
  const server = createServer(app)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      openServers.add(server)
      resolve(server)
    })
  })
}

export function buildTestApp(
  db: Database,
  overrides: Partial<ServerDependencies> = {}
): Promise<Server> {
  const app = buildApp({
    db,
    logger: createFakeLogger(),
    publicAppUrl: TEST_PUBLIC_APP_URL,
    emailSender: new RecordingEmailSender(),
    buildSignInLink: (token) => `${TEST_PUBLIC_APP_URL}/sign-in/${token}`,
    googleVerifier: createFakeGoogleVerifier(),
    // TEN-4 — a fake `DiscordRestClient` by default (no network); a test
    // that needs a particular guild list or exchange result overrides this
    // directly with its own `createFakeDiscordRestClient(...)` call.
    discordRestClient: createFakeDiscordRestClient(),
    discordClientId: 'test-discord-client-id',
    discordBotToken: 'test-discord-bot-token',
    discordRedirectUri: `${TEST_PUBLIC_APP_URL}/discord/callback`,
    // Never `CONFIG.DISCORD_OAUTH_BASE`'s real default — this package's own
    // test suite never sets `process.env`'s Discord/`PUBLIC_APP_URL`
    // variables, by design (`routes/discord-servers.ts`'s own doc comment).
    discordOauthBase: 'https://discord.test/oauth2',
    attachmentStorageDir: TEST_ATTACHMENT_STORAGE_DIR,
    // WEB-10 — no network, a fixed answer, by default; a test that wants a
    // particular response (or to observe what `routes/chat.ts` actually
    // asked) overrides this directly with its own `new FakeModelClient(...)`
    // call, the same "a test overrides only the one field its own scenario
    // needs" convention this helper's own module comment already states.
    model: new FakeModelClient(),
    ...overrides,
  })
  return startTestServer(app)
}
