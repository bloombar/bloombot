/**
 * API-3 (and the origin half of AUTH-3 `packages/auth`'s D-19 deferred to
 * this slice): a non-GET request whose origin does not match this API's own
 * `publicAppUrl` is refused before it ever reaches a route, let alone
 * dispatches an action. Proven against a real registered action with a
 * recording `execute` — not just a status code — so a change that moved
 * the check *after* dispatch instead of before it would still fail this
 * even if it happened to also return 403.
 */

import { randomUUID } from 'node:crypto'

import { ActionRegistry, type Action } from '@bloombot/actions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import request from 'supertest'

import { buildTestApp, TEST_PUBLIC_APP_URL } from '../helpers/build-test-app.js'
import { seedSignedInCaller } from '../helpers/seed.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** A minimal action, registered so `dispatch` can actually be reached — `execute` is a `vi.fn()` a test can assert against directly. */
function buildRecordingRegistry() {
  const execute = vi.fn(() => 'recorded')
  const action: Action<'test.record', { id: string }, { id: string }, string> =
    {
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
  return { registry, execute }
}

describe('API-3 — non-GET requests are checked against their origin', () => {
  it('refuses a POST with a foreign Origin, and never dispatches the action', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { registry, execute } = buildRecordingRegistry()
    const app = buildTestApp(testDb.db, { registry })

    const response = await request(app)
      .post(`/organizations/${caller.organizationId}/actions/test.record`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', 'https://evil.example')
      .send({ id: randomUUID() })

    expect(response.status).toBe(403)
    expect(execute).not.toHaveBeenCalled()
  })

  it('allows a POST whose Origin matches, reaching dispatch', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { registry, execute } = buildRecordingRegistry()
    const app = buildTestApp(testDb.db, { registry })

    const response = await request(app)
      .post(`/organizations/${caller.organizationId}/actions/test.record`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ id: randomUUID() })

    expect(response.status).toBe(200)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('falls back to Referer when Origin is absent, and still refuses a foreign one', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { registry, execute } = buildRecordingRegistry()
    const app = buildTestApp(testDb.db, { registry })

    const response = await request(app)
      .post(`/organizations/${caller.organizationId}/actions/test.record`)
      .set('Cookie', caller.cookieHeader)
      .set('Referer', 'https://evil.example/some/page')
      .send({ id: randomUUID() })

    expect(response.status).toBe(403)
    expect(execute).not.toHaveBeenCalled()
  })

  it('accepts a matching Referer when Origin is absent', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { registry, execute } = buildRecordingRegistry()
    const app = buildTestApp(testDb.db, { registry })

    const response = await request(app)
      .post(`/organizations/${caller.organizationId}/actions/test.record`)
      .set('Cookie', caller.cookieHeader)
      .set('Referer', `${TEST_PUBLIC_APP_URL}/some/page`)
      .send({ id: randomUUID() })

    expect(response.status).toBe(200)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  // Deliberate choice (docs/DECISIONS.md): a non-GET request with neither
  // header present is refused, not let through — "absent" is not "allowed."
  it('refuses a POST with neither Origin nor Referer present', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const { registry, execute } = buildRecordingRegistry()
    const app = buildTestApp(testDb.db, { registry })

    const response = await request(app)
      .post(`/organizations/${caller.organizationId}/actions/test.record`)
      .set('Cookie', caller.cookieHeader)
      .send({ id: randomUUID() })

    expect(response.status).toBe(403)
    expect(execute).not.toHaveBeenCalled()
  })

  it('a GET is unaffected by a foreign Origin', async () => {
    testDb = createTestDatabase()
    const app = buildTestApp(testDb.db)

    const response = await request(app)
      .get('/health')
      .set('Origin', 'https://evil.example')

    // Whatever /health itself reports, it is not the 403 the origin check
    // would produce for a non-GET — proving the check never ran at all.
    expect(response.status).not.toBe(403)
  })
})
