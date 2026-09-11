/**
 * `routes/mcp-oauth-consent.ts` (MCP-7's own human-facing half). Every test
 * here writes the pending authorization directly through `@bloombot/auth`'s
 * `beginAuthorization` — the same "written through the real repos, never
 * through the surface under test" convention `person-link.test.ts`'s own
 * module comment already holds this test directory to — since
 * `apps/mcp`'s own `authorize()` is `apps/mcp/tests/oauth-http.test.ts`'s
 * job to prove, not this file's.
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import {
  beginAuthorization,
  peekPendingAuthorization,
  registerOauthClient,
} from '@bloombot/auth'

import { buildTestApp, TEST_PUBLIC_APP_URL } from '../helpers/build-test-app.js'
import { seedSignedInCaller } from '../helpers/seed.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

function beginPending(
  db: TestDatabase['db'],
  overrides: { state?: string } = {}
) {
  const client = registerOauthClient(
    { redirectUris: ['https://client.example/callback'] },
    db
  )
  const clientId = client.id
  return beginAuthorization(
    {
      clientId,
      redirectUri: 'https://client.example/callback',
      codeChallenge: 'a-fake-challenge',
      ...(overrides.state !== undefined ? { state: overrides.state } : {}),
    },
    db
  )
}

describe('GET /oauth/mcp/authorize', () => {
  it('tells a signed-out caller to sign in, without creating anything', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)
    const begun = beginPending(testDb.db)

    const response = await request(app)
      .get('/oauth/mcp/authorize')
      .query({ request: begun.id })

    expect(response.status).toBe(200)
    expect(response.text).toMatch(/sign in/i)
    // Still there — a preview never spends it (LINK-6's own "a visit is not
    // consent", the same discipline this route's own module comment holds
    // itself to).
    expect(peekPendingAuthorization(begun.id, testDb.db)).toBeDefined()
  })

  it('shows a plain consent screen naming what is being granted, to a signed-in caller', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)
    const caller = seedSignedInCaller(testDb.db)
    const begun = beginPending(testDb.db)

    const response = await request(app)
      .get('/oauth/mcp/authorize')
      .query({ request: begun.id })
      .set('Cookie', caller.cookieHeader)

    expect(response.status).toBe(200)
    expect(response.text).toMatch(/act as your Bloombot account/i)
  })

  it('answers plainly for an expired or unknown request id', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .get('/oauth/mcp/authorize')
      .query({ request: randomUUID() })

    expect(response.status).toBe(404)
    expect(response.text).toMatch(/expired|already used/i)
  })
})

describe('POST /oauth/mcp/authorize/decide', () => {
  it('refuses without a signed-in session', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)
    const begun = beginPending(testDb.db)

    const response = await request(app)
      .post('/oauth/mcp/authorize/decide')
      .type('form')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ request: begun.id, decision: 'allow' })

    expect(response.status).toBe(401)
  })

  it("binds the code to the signed-in caller's own account, never a request field", async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)
    const caller = seedSignedInCaller(testDb.db)
    const otherAccountId = randomUUID()
    const begun = beginPending(testDb.db, { state: 'carry-me' })

    const response = await request(app)
      .post('/oauth/mcp/authorize/decide')
      .type('form')
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      // A malicious or merely confused client field naming a *different*
      // account — must never be read. There is no such field in this
      // route's own input schema at all, which this call proves by simply
      // never affecting anything: the redirect below still names the
      // consenting caller's own real code, not one for `otherAccountId`.
      .send({ request: begun.id, decision: 'allow', accountId: otherAccountId })

    expect(response.status).toBe(302)
    const redirect = new URL(response.headers['location'] as string)
    expect(redirect.origin + redirect.pathname).toBe(
      'https://client.example/callback'
    )
    expect(redirect.searchParams.get('code')).toBeDefined()
    expect(redirect.searchParams.get('state')).toBe('carry-me')
  })

  it('a decline redirects to the client with access_denied, and consumes the pending authorization', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)
    const caller = seedSignedInCaller(testDb.db)
    const begun = beginPending(testDb.db)

    const response = await request(app)
      .post('/oauth/mcp/authorize/decide')
      .type('form')
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ request: begun.id, decision: 'deny' })

    expect(response.status).toBe(302)
    const redirect = new URL(response.headers['location'] as string)
    expect(redirect.searchParams.get('error')).toBe('access_denied')
    expect(peekPendingAuthorization(begun.id, testDb.db)).toBeUndefined()
  })

  it('an already-used or expired request id answers plainly rather than failing obscurely', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)
    const caller = seedSignedInCaller(testDb.db)

    const response = await request(app)
      .post('/oauth/mcp/authorize/decide')
      .type('form')
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ request: randomUUID(), decision: 'allow' })

    expect(response.status).toBe(404)
    expect(response.text).toMatch(/expired|already used/i)
  })
})
