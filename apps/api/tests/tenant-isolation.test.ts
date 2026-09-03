/**
 * TEN-5's own test matrix, named by the requirement: every organization-
 * scoped route this API exposes, exercised against (a) another
 * organization's session, (b) no session, and (c) a disabled account's
 * session.
 *
 * The route list is derived, not hand-typed, for the same reason ACT-5's
 * own access-audit index (`packages/actions/tests/access-audit.test.ts`) is:
 * `ACTION_ROUTES` below is built from `createPlatformRegistry()`, so a new
 * action registered anywhere reaches this table with no edit here — and the
 * "found the routes this test is written against" guard immediately below
 * fails the moment that changes the route count, forcing a deliberate
 * decision to widen the list rather than silently leaving a new route
 * unchecked. `BESPOKE_ROUTES` (TEN-4's own two routes, not actions —
 * `routes/discord-servers.ts`'s own module comment explains why) used to be
 * hand-typed the same way, and was finding 2 of the TEN-4..6 rework because
 * of it: nothing enumerated the Express route table, so a later route added
 * to that file without a row here would sail through unnoticed — the
 * registry it could have been checked against does not exist, because it is
 * not an action. `collectRouterRoutes` below (Express 5's own `Router`
 * exposes every route it holds, at any nesting depth, as a `.route` on a
 * `Layer` — `node_modules/router/lib/layer.js`) walks `buildDiscordServersRouter`'s
 * own router the same way `ACTION_ROUTES` walks the registry, so a route
 * added there needs no edit here either: it reaches `BESPOKE_ROUTES`, is
 * exercised by the loop below, and the same "did the route list change"
 * guard fails the moment its count does. The one piece this cannot derive —
 * Express 5's `Layer` carries no textual mount path, only a compiled
 * `path-to-regexp` matcher closure, so there is nothing to read a *prefix*
 * back out of — is `DISCORD_SERVERS_MOUNT` below, matching `server.ts`'s own
 * mount call. That is deliberately the one literal left: it names a router
 * *family*, not a route, and the failure mode this finding is about (a new
 * *endpoint* silently missing a row) cannot happen by way of it.
 *
 * **What "identical" means here.** `routes/actions.ts` (every action route)
 * and `routes/discord-servers.ts` (both bespoke routes) already share one
 * shape, inherited rather than reinvented by this slice: an anonymous
 * caller is refused before anything else runs (`401`, "not signed in" — a
 * different concern from TEN-5's own "does this record exist for you",
 * API-1's own layer), and everything else — a foreign organization's
 * membership, an install state that resolves to a different organization, a
 * guild the caller does not administer, a server bound elsewhere — is the
 * same `ActionRefusedError` (`404`, TEN-5). A *disabled* account's session
 * does not reach a third, distinct shape: `sessionMiddleware`
 * (`@bloombot/db`'s own `validateSession`) refuses a disabled account's
 * token the same way it refuses a token that was never issued, so `req.session`
 * is `undefined` in both cases — (b) and (c) below assert *the exact same*
 * status and body for that reason, not merely "both look like a refusal".
 * (a) is asserted separately as TEN-5's own not-found shape, `404`.
 */

import type { Server } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import { accounts, type AttachmentStorage, type Database } from '@bloombot/db'
import { createPlatformRegistry } from '@bloombot/actions'

import { buildDiscordServersRouter } from '../src/routes/discord-servers.js'
import { buildTranscriptExportsRouter } from '../src/routes/transcript-exports.js'
import { buildTestApp, TEST_PUBLIC_APP_URL } from './helpers/build-test-app.js'
import { createFakeDiscordRestClient } from './helpers/fake-discord-rest-client.js'
import { createFakeLogger } from './helpers/fake-logger.js'
import { seedOtherOrganization, seedSignedInCaller } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

/** An HTTP method as Express's own `Layer#route.methods` records it — lowercase, matching `router.<method>(...)`. */
type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete'

interface RouteCase {
  routeName: string
  method: HttpMethod
  path: (organizationId: string) => string
}

/** The minimal shape this file reads off Express 5's `Router`/`Layer` — `node_modules/router/lib/layer.js` — to walk a router's own routes without depending on anything not part of that shape. */
interface ExpressLayer {
  name: string
  route?: { path: string; methods: Record<string, boolean> }
  handle?: { stack?: ExpressLayer[] }
}

/** Every `.route` a router (or a router nested inside it, at any depth) holds — method(s) and its path *relative to that router's own mount*. The same recursive walk `layer.handle.stack` invites for any router-inside-a-router, which is exactly the shape `buildDiscordServersRouter`'s `Router({ mergeParams: true })` has once mounted. */
function collectRouterRoutes(
  stack: ExpressLayer[]
): { methods: HttpMethod[]; path: string }[] {
  const routes: { methods: HttpMethod[]; path: string }[] = []
  for (const layer of stack) {
    if (layer.route) {
      routes.push({
        methods: Object.keys(layer.route.methods) as HttpMethod[],
        path: layer.route.path,
      })
    } else if (layer.name === 'router' && layer.handle?.stack) {
      routes.push(...collectRouterRoutes(layer.handle.stack))
    }
  }
  return routes
}

/** One row per registered action — `POST /organizations/:organizationId/actions/:name`, `routes/actions.ts`'s one generic route. */
const ACTION_ROUTES: RouteCase[] = createPlatformRegistry()
  .list()
  .map((action) => ({
    routeName: `POST /organizations/:organizationId/actions/${action.name}`,
    method: 'post',
    path: (organizationId: string) =>
      `/organizations/${organizationId}/actions/${action.name}`,
  }))

// The mount prefix `server.ts` gives `buildDiscordServersRouter` — see this
// file's own module comment for why this, and only this, stays a literal.
const DISCORD_SERVERS_MOUNT = '/organizations/:organizationId/discord-servers'

/**
 * TEN-4's bespoke routes (finding 2 of the TEN-4..6 rework) — walked off the
 * router `buildDiscordServersRouter` actually returns, not hand-typed.
 * `{} as Database` is never touched: building a router only closes over
 * `deps.db` for a request this file never sends it, so introspecting the
 * router's own `.stack` needs no real database.
 */
const discordServersRouter = buildDiscordServersRouter({
  db: {} as Database,
  logger: createFakeLogger(),
  discordRestClient: createFakeDiscordRestClient(),
  discordClientId: 'route-discovery-only',
  discordBotToken: 'route-discovery-only',
  discordRedirectUri: 'https://app.bloombot.test/discord/callback',
  discordOauthBase: 'https://discord.test/oauth2',
}) as unknown as { stack: ExpressLayer[] }

const BESPOKE_ROUTES: RouteCase[] = collectRouterRoutes(
  discordServersRouter.stack
).flatMap((route) =>
  route.methods.map((method) => ({
    routeName: `${method.toUpperCase()} ${DISCORD_SERVERS_MOUNT}${route.path}`,
    method,
    path: (organizationId: string) =>
      `/organizations/${organizationId}/discord-servers${route.path}`,
  }))
)

// ADMIN-3's own download route — the same "walked off the router it
// actually returns, not hand-typed" discipline `BESPOKE_ROUTES` above
// already follows for TEN-4's two. `{} as AttachmentStorage` is never
// touched: this file's own three cases (a/b/c, below) are all refused
// before this router's own `attachmentStorage.read` call is ever reached
// (the membership check runs first, the same order every other bespoke
// route in this file already holds itself to) — a placeholder `:exportId`
// segment in the path is harmless for the same reason: none of (a)/(b)/(c)
// ever expects a *successful* response, only a refusal shape.
const TRANSCRIPT_EXPORTS_MOUNT =
  '/organizations/:organizationId/transcript-exports'
const transcriptExportsRouter = buildTranscriptExportsRouter({
  db: {} as Database,
  attachmentStorage: {} as AttachmentStorage,
}) as unknown as { stack: ExpressLayer[] }

const TRANSCRIPT_EXPORTS_ROUTES: RouteCase[] = collectRouterRoutes(
  transcriptExportsRouter.stack
).flatMap((route) =>
  route.methods.map((method) => ({
    routeName: `${method.toUpperCase()} ${TRANSCRIPT_EXPORTS_MOUNT}${route.path}`,
    method,
    path: (organizationId: string) =>
      `/organizations/${organizationId}/transcript-exports${route.path}`,
  }))
)

const ALL_ROUTES = [
  ...ACTION_ROUTES,
  ...BESPOKE_ROUTES,
  ...TRANSCRIPT_EXPORTS_ROUTES,
]

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('TEN-5 — every organization-scoped route, against a foreign session, no session, and a disabled account', () => {
  it('found the routes this test is written against — a new one changes this count', () => {
    testDb = createTestDatabase() // afterEach expects testDb set, even here
    expect(ALL_ROUTES.map((r) => r.routeName).sort()).toEqual(
      [
        'POST /organizations/:organizationId/actions/projects.create',
        'POST /organizations/:organizationId/actions/projects.archive',
        'POST /organizations/:organizationId/actions/projects.unarchive',
        'POST /organizations/:organizationId/actions/projects.list',
        'POST /organizations/:organizationId/actions/projects.duplicate',
        'POST /organizations/:organizationId/actions/courses.save',
        'POST /organizations/:organizationId/actions/courses.enable',
        'POST /organizations/:organizationId/actions/courses.disable',
        'POST /organizations/:organizationId/actions/courses.list',
        'POST /organizations/:organizationId/actions/courses.get',
        'POST /organizations/:organizationId/actions/discordServers.remove',
        'POST /organizations/:organizationId/actions/discordServers.list',
        'POST /organizations/:organizationId/actions/discordServers.scaffold',
        'POST /organizations/:organizationId/actions/jobs.get',
        'POST /organizations/:organizationId/actions/roster.import',
        'POST /organizations/:organizationId/actions/courseAttachments.attach',
        'POST /organizations/:organizationId/actions/courseAttachments.list',
        'POST /organizations/:organizationId/actions/courseAttachments.detach',
        'POST /organizations/:organizationId/actions/courseInstructions.save',
        'POST /organizations/:organizationId/actions/courseInstructions.list',
        'POST /organizations/:organizationId/actions/courseInstructions.restore',
        'POST /organizations/:organizationId/actions/costLedger.organizationUsage',
        'POST /organizations/:organizationId/actions/costLedger.setSpendingCap',
        'POST /organizations/:organizationId/actions/courseJoinLinks.create',
        'POST /organizations/:organizationId/actions/courseJoinLinks.list',
        'POST /organizations/:organizationId/actions/courseJoinLinks.revoke',
        'POST /organizations/:organizationId/actions/enrolments.listForPerson',
        'POST /organizations/:organizationId/actions/enrolments.checkAccess',
        'POST /organizations/:organizationId/actions/enrolments.end',
        'POST /organizations/:organizationId/actions/enrolments.reinstate',
        'POST /organizations/:organizationId/actions/enrolments.listForCourse',
        'POST /organizations/:organizationId/actions/memberships.grant',
        'POST /organizations/:organizationId/actions/memberships.list',
        'POST /organizations/:organizationId/actions/membershipInvitations.create',
        'POST /organizations/:organizationId/actions/membershipInvitations.list',
        'POST /organizations/:organizationId/actions/membershipInvitations.revoke',
        'POST /organizations/:organizationId/actions/transcripts.read',
        'POST /organizations/:organizationId/actions/transcripts.listStudents',
        'POST /organizations/:organizationId/actions/transcripts.export',
        'POST /organizations/:organizationId/actions/transcripts.listExports',
        'POST /organizations/:organizationId/discord-servers/install/begin',
        'POST /organizations/:organizationId/discord-servers/install/callback',
        'GET /organizations/:organizationId/transcript-exports/:exportId/download',
      ].sort()
    )
  })

  // `route.method`-aware (finding 2 of the TEN-4..6 rework): every route
  // this file currently derives happens to be `POST`, but a route
  // `collectRouterRoutes` finds tomorrow need not be — sending every one of
  // them a hardcoded `POST` regardless of the method it actually registers
  // would 404 on the method mismatch alone, passing (a) by accident and
  // failing to exercise the route's own authorization at all.
  function send(
    app: Server,
    method: HttpMethod,
    path: string,
    cookieHeader?: string
  ) {
    const req = request(app)[method](path).set('Origin', TEST_PUBLIC_APP_URL)
    return cookieHeader ? req.set('Cookie', cookieHeader) : req
  }

  for (const route of ALL_ROUTES) {
    describe(route.routeName, () => {
      it("(a) another organization's session: refused not-found-shaped (404)", async () => {
        testDb = createTestDatabase()
        const caller = seedSignedInCaller(testDb.db)
        const otherOrganizationId = seedOtherOrganization(testDb.db)
        const app = await buildTestApp(testDb.db)

        const response = await send(
          app,
          route.method,
          route.path(otherOrganizationId),
          caller.cookieHeader
        ).send({})

        expect(response.status).toBe(404)
        expect(response.body).toEqual({ error: 'action_refused' })
      })

      it('(b) no session: refused (401)', async () => {
        testDb = createTestDatabase()
        const caller = seedSignedInCaller(testDb.db)
        const app = await buildTestApp(testDb.db)

        const response = await send(
          app,
          route.method,
          route.path(caller.organizationId)
        ).send({})

        expect(response.status).toBe(401)
      })

      it('(c) a disabled account session: refused identically to (b), no session at all', async () => {
        testDb = createTestDatabase()
        const caller = seedSignedInCaller(testDb.db)
        const app = await buildTestApp(testDb.db)

        const withoutSession = await send(
          app,
          route.method,
          route.path(caller.organizationId)
        ).send({})

        accounts.disableAccount(caller.accountId, testDb.db)
        const withDisabledSession = await send(
          app,
          route.method,
          route.path(caller.organizationId),
          caller.cookieHeader
        ).send({})

        expect(withDisabledSession.status).toBe(withoutSession.status)
        expect(withDisabledSession.body).toEqual(withoutSession.body)
      })
    })
  }
})
