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

  // Must-fix 4 of the API-1..6 rework: `body-parser`'s own errors (via
  // `http-errors`) carry a numeric `status`/`statusCode` and `expose: true`
  // for a client-caused parse failure, but no `code` — so `actionErrorCode`
  // never matched them and they fell all the way to the "unexpected" `500`
  // branch, each writing an error-level log line. Body parsing runs *before*
  // `originCheck` (`server.ts`'s own ordering comment), so this is reachable
  // by an unauthenticated, cross-origin caller — proven here with no
  // `Origin` header set at all, and still answering `400`, not the `403`
  // `originCheck` would give a non-GET request with neither header present.
  it('malformed JSON is a 400, not a 500, and logs nothing at error level', async () => {
    testDb = createTestDatabase()
    const logger = createFakeLogger()
    const app = buildTestApp(testDb.db, { logger })

    const response = await request(app)
      .post('/auth/sign-out')
      .set('Content-Type', 'application/json')
      .send('{ this is not valid json')

    expect(response.status).toBe(400)
    expect(response.status).not.toBe(403) // not the origin check, either
    expect(response.body).not.toEqual({ error: 'internal_error' })
    expect(logger.errorCalls).toHaveLength(0)
  })

  // Same shape, for `express.json()`'s own size limit — an over-limit body
  // is `413`, `expose: true`, no `code`, same pre-origin-check reachability.
  it('an over-limit body is a 413, not a 500, and logs nothing at error level', async () => {
    testDb = createTestDatabase()
    const logger = createFakeLogger()
    const app = buildTestApp(testDb.db, { logger })

    // `express.json()` defaults to a 100kb limit (`server.ts`); comfortably
    // over it without relying on any non-default configuration.
    const oversizedBody = JSON.stringify({ padding: 'x'.repeat(200_000) })

    const response = await request(app)
      .post('/auth/sign-out')
      .set('Content-Type', 'application/json')
      .send(oversizedBody)

    expect(response.status).toBe(413)
    expect(response.body).not.toEqual({ error: 'internal_error' })
    expect(logger.errorCalls).toHaveLength(0)
  })
})
