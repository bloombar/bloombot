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
 * unchecked. `BESPOKE_ROUTES` is the two routes TEN-4 adds that are not
 * actions at all (`routes/discord-servers.ts`'s own module comment explains
 * why) and so cannot be derived the same way — added by hand, the same way
 * `BESPOKE_ROUTES` itself would need a second row for any future one.
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

import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'

import { accounts } from '@bloombot/db'
import { createPlatformRegistry } from '@bloombot/actions'

import { buildTestApp, TEST_PUBLIC_APP_URL } from './helpers/build-test-app.js'
import { seedOtherOrganization, seedSignedInCaller } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

interface RouteCase {
  routeName: string
  path: (organizationId: string) => string
}

/** One row per registered action — `POST /organizations/:organizationId/actions/:name`, `routes/actions.ts`'s one generic route. */
const ACTION_ROUTES: RouteCase[] = createPlatformRegistry()
  .list()
  .map((action) => ({
    routeName: `POST /organizations/:organizationId/actions/${action.name}`,
    path: (organizationId: string) =>
      `/organizations/${organizationId}/actions/${action.name}`,
  }))

/** TEN-4's two bespoke routes — not actions, so not derivable from the registry (`routes/discord-servers.ts`'s own module comment). */
const BESPOKE_ROUTES: RouteCase[] = [
  {
    routeName:
      'POST /organizations/:organizationId/discord-servers/install/begin',
    path: (organizationId: string) =>
      `/organizations/${organizationId}/discord-servers/install/begin`,
  },
  {
    routeName:
      'POST /organizations/:organizationId/discord-servers/install/callback',
    path: (organizationId: string) =>
      `/organizations/${organizationId}/discord-servers/install/callback`,
  },
]

const ALL_ROUTES = [...ACTION_ROUTES, ...BESPOKE_ROUTES]

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
        'POST /organizations/:organizationId/actions/courses.save',
        'POST /organizations/:organizationId/actions/courses.enable',
        'POST /organizations/:organizationId/actions/courses.disable',
        'POST /organizations/:organizationId/actions/discordServers.remove',
        'POST /organizations/:organizationId/discord-servers/install/begin',
        'POST /organizations/:organizationId/discord-servers/install/callback',
      ].sort()
    )
  })

  function post(app: Express, path: string, cookieHeader?: string) {
    const req = request(app).post(path).set('Origin', TEST_PUBLIC_APP_URL)
    return cookieHeader ? req.set('Cookie', cookieHeader) : req
  }

  for (const route of ALL_ROUTES) {
    describe(route.routeName, () => {
      it("(a) another organization's session: refused not-found-shaped (404)", async () => {
        testDb = createTestDatabase()
        const caller = seedSignedInCaller(testDb.db)
        const otherOrganizationId = seedOtherOrganization(testDb.db)
        const app = buildTestApp(testDb.db)

        const response = await post(
          app,
          route.path(otherOrganizationId),
          caller.cookieHeader
        ).send({})

        expect(response.status).toBe(404)
        expect(response.body).toEqual({ error: 'action_refused' })
      })

      it('(b) no session: refused (401)', async () => {
        testDb = createTestDatabase()
        const caller = seedSignedInCaller(testDb.db)
        const app = buildTestApp(testDb.db)

        const response = await post(
          app,
          route.path(caller.organizationId)
        ).send({})

        expect(response.status).toBe(401)
      })

      it('(c) a disabled account session: refused identically to (b), no session at all', async () => {
        testDb = createTestDatabase()
        const caller = seedSignedInCaller(testDb.db)
        const app = buildTestApp(testDb.db)

        const withoutSession = await post(
          app,
          route.path(caller.organizationId)
        ).send({})

        accounts.disableAccount(caller.accountId, testDb.db)
        const withDisabledSession = await post(
          app,
          route.path(caller.organizationId),
          caller.cookieHeader
        ).send({})

        expect(withDisabledSession.status).toBe(withoutSession.status)
        expect(withDisabledSession.body).toEqual(withoutSession.body)
      })
    })
  }
})
