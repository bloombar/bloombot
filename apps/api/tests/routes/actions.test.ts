/**
 * API-1: a route carries, it does not decide. Two things only this route
 * could get wrong, proven directly: an anonymous caller cannot dispatch an
 * authenticated action, and the organization an action runs against is
 * always the caller's own membership — never whatever the request body
 * claims, even when the body names a real, different organization.
 */

import { ActionRegistry, type Action } from '@bloombot/actions'
import { projects } from '@bloombot/db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import request from 'supertest'

import { buildTestApp, TEST_PUBLIC_APP_URL } from '../helpers/build-test-app.js'
import { seedSignedInCaller, seedOtherOrganization } from '../helpers/seed.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('API-1 — routes carry, they do not decide', () => {
  it('an anonymous caller (no session cookie) cannot dispatch an action', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)

    const execute = vi.fn(() => 'should never run')
    const action: Action<
      'test.record',
      { id: string },
      { id: string },
      string
    > = {
      name: 'test.record',
      description: 'Records whether it was ever called.',
      inputSchema: z.object({ id: z.string().min(1) }),
      policy: {
        descriptor: { resource: 'test', access: 'write' },
        resolve: (input) => ({ id: input.id }),
      },
      execute,
    }
    const registry = new ActionRegistry()
    registry.register(action)
    const app = buildTestApp(testDb.db, { registry })

    const response = await request(app)
      .post(`/organizations/${caller.organizationId}/actions/test.record`)
      .set('Origin', TEST_PUBLIC_APP_URL)
      // No `Cookie` header at all — an anonymous request.
      .send({ id: 'x' })

    expect(response.status).toBe(401)
    expect(execute).not.toHaveBeenCalled()
  })

  it('a session for one organization cannot dispatch against an organization it has no membership in', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const otherOrganizationId = seedOtherOrganization(testDb.db)
    const app = buildTestApp(testDb.db)

    const response = await request(app)
      .post(`/organizations/${otherOrganizationId}/actions/projects.create`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ name: 'Should Not Be Created' })

    // ACT-3 / TEN-5: refused the same way a missing record is, not a
    // different "forbidden" shape that would disclose the organization
    // exists.
    expect(response.status).toBe(404)
  })

  it("the organization used is the caller's own membership, even when the body names a different, real organization", async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const otherOrganizationId = seedOtherOrganization(testDb.db)
    const app = buildTestApp(testDb.db)

    const response = await request(app)
      .post(`/organizations/${caller.organizationId}/actions/projects.create`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      // `organizationId` here is not a field `projects.create`'s own input
      // schema declares — it is stripped by `dispatch`'s zod validation
      // before it ever reaches the policy — but even if it were not, the
      // route resolves the organization from the caller's membership, not
      // from this body, before dispatch is ever called.
      .send({ name: 'Caller Org Project', organizationId: otherOrganizationId })

    expect(response.status).toBe(200)
    const createdId = (response.body as { result: { id: string } }).result.id

    expect(
      projects.getProject(caller.organizationId, createdId, testDb.db)
    ).toBeDefined()
    expect(
      projects.getProject(otherOrganizationId, createdId, testDb.db)
    ).toBeUndefined()
  })

  // Finding 5 (rework pass): a zero-input read action (every field optional
  // or none at all — `projects.list`, `discordServers.list`) has to work on
  // a body-less `POST` too, not only when a caller sends `{}` explicitly.
  // Express 5 leaves `req.body` `undefined` when no request body carries a
  // matching `Content-Type` — `dispatch`'s own tests never exercise this,
  // since they call `dispatch` directly with `{}`, and the browser client
  // always sends a JSON body — so only a real HTTP request with no body at
  // all reproduces it.
  it('a zero-input read action succeeds on a body-less POST, not just an explicit {}', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const app = buildTestApp(testDb.db)

    const response = await request(app)
      .post(`/organizations/${caller.organizationId}/actions/projects.list`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
    // No `.send(...)` at all — no `Content-Type` header, so `req.body` is
    // `undefined`, not `{}`.

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ result: [] })
  })
})
