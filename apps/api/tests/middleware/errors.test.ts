/**
 * API-4 / ACT-4: one middleware turns every thrown error into a status and
 * a body, using `@bloombot/actions`'s own `HTTP_STATUS_BY_ACTION_ERROR`
 * table — no route in `routes/actions.ts` maps anything itself. Exercised
 * over real HTTP, against real registered actions, rather than by calling
 * `errorMiddleware` directly, so a route that started catching and mapping
 * its own error would also fail this.
 */

import { randomUUID } from 'node:crypto'

import { ActionRegistry, type Action } from '@bloombot/actions'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import request from 'supertest'

import { buildTestApp, TEST_PUBLIC_APP_URL } from '../helpers/build-test-app.js'
import { seedSignedInCaller } from '../helpers/seed.js'
import { createFakeLogger } from '../helpers/fake-logger.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Strips the fields expected to vary (e.g. nothing here, but keeps the assertion honest about which fields are compared) so two responses can be compared byte-for-byte. */
function bodyOf(response: request.Response): unknown {
  return response.body as unknown
}

describe('API-4 — one middleware maps every action error to a status', () => {
  it("a missing record and another organization's record refuse identically", async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const otherOrgCaller = seedSignedInCaller(testDb.db)
    const app = buildTestApp(testDb.db)

    // Give the *other* organization a real project, so this is genuinely
    // "belongs to someone else," not merely "never existed."
    const createInOther = await request(app)
      .post(
        `/organizations/${otherOrgCaller.organizationId}/actions/projects.create`
      )
      .set('Cookie', otherOrgCaller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ name: 'Someone Else’s Project' })
    expect(createInOther.status).toBe(200)
    const otherOrgsProjectId = (
      createInOther.body as { result: { id: string } }
    ).result.id

    const missing = await request(app)
      .post(`/organizations/${caller.organizationId}/actions/projects.archive`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ projectId: randomUUID() })

    const forbidden = await request(app)
      .post(`/organizations/${caller.organizationId}/actions/projects.archive`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ projectId: otherOrgsProjectId })

    expect(missing.status).toBe(404)
    expect(forbidden.status).toBe(404)
    expect(bodyOf(missing)).toEqual(bodyOf(forbidden))
  })

  it('a validation failure is a 400 carrying the field errors', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const app = buildTestApp(testDb.db)

    const response = await request(app)
      .post(`/organizations/${caller.organizationId}/actions/projects.create`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({}) // missing the required `name` field

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: 'action_input_invalid' })
    expect(Array.isArray((response.body as { issues: unknown[] }).issues)).toBe(
      true
    )
    expect(
      (response.body as { issues: unknown[] }).issues.length
    ).toBeGreaterThan(0)
  })

  it('an unexpected error is a 500 whose body carries no detail — the log carries it instead', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)

    const explodingAction: Action<
      'test.explode',
      { id: string },
      { id: string },
      never
    > = {
      name: 'test.explode',
      description:
        'Always throws an error unrelated to any typed action error.',
      inputSchema: z.object({ id: z.string().min(1) }),
      policy: {
        descriptor: { resource: 'test', access: 'write' },
        resolve: (input) => ({ id: input.id }),
      },
      execute: () => {
        throw new Error(
          'a secret internal detail that must never reach the caller'
        )
      },
    }
    const registry = new ActionRegistry()
    registry.register(explodingAction)
    const logger = createFakeLogger()
    const app = buildTestApp(testDb.db, { registry, logger })

    const response = await request(app)
      .post(`/organizations/${caller.organizationId}/actions/test.explode`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ id: randomUUID() })

    expect(response.status).toBe(500)
    expect(response.body).toEqual({ error: 'internal_error' })
    expect(JSON.stringify(response.body)).not.toContain(
      'secret internal detail'
    )

    // The detail withheld from the response is exactly what the log got.
    // `JSON.stringify` on the fields object would not see it — `Error#message`
    // is not its own enumerable property — so this reads the logged error
    // object directly, the way pino's own serializer (not exercised by this
    // fake) would still have the real message to serialize from.
    expect(logger.errorCalls.length).toBeGreaterThan(0)
    const [fields] = logger.errorCalls[0]!
    const loggedError = (fields as { err: Error }).err
    expect(loggedError).toBeInstanceOf(Error)
    expect(loggedError.message).toContain('secret internal detail')
  })
})
