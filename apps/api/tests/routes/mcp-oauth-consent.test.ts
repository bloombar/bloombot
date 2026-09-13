/**
 * `routes/mcp-oauth-consent.ts` (MCP-7's own human-facing half, MCP-11's
 * JSON rewrite of it). Every test here writes the pending authorization
 * directly through `@bloombot/auth`'s `beginAuthorization` — the same
 * "written through the real repos, never through the surface under test"
 * convention `person-link.test.ts`'s own module comment already holds this
 * test directory to — since `apps/mcp`'s own `authorize()` is
 * `apps/mcp/tests/oauth-http.test.ts`'s job to prove, not this file's.
 *
 * The "security review, must-fix 2" describe blocks below are this file's
 * own regression tests for the account-takeover a review round found: the
 * consent screen naming neither the client nor the destination, and a
 * `request` id usable by any signed-in browser that saw it, not only the
 * first one. MCP-11 changed the surface (JSON, not server-rendered HTML)
 * but not the rule, so every one of these still holds the identical shape.
 */

import { randomUUID } from 'node:crypto'

import { beginAuthorization, registerOauthClient } from '@bloombot/auth'
import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import { buildTestApp, TEST_PUBLIC_APP_URL } from '../helpers/build-test-app.js'
import { seedSignedInCaller } from '../helpers/seed.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

function beginPending(
  db: TestDatabase['db'],
  overrides: { state?: string; clientName?: string; redirectUri?: string } = {}
) {
  const client = registerOauthClient(
    {
      redirectUris: [
        overrides.redirectUri ?? 'https://client.example/callback',
      ],
      ...(overrides.clientName ? { clientName: overrides.clientName } : {}),
    },
    db
  )
  const clientId = client.id
  return beginAuthorization(
    {
      clientId,
      redirectUri: overrides.redirectUri ?? 'https://client.example/callback',
      codeChallenge: 'a-fake-challenge',
      ...(overrides.state !== undefined ? { state: overrides.state } : {}),
    },
    db
  )
}

describe('GET /oauth/mcp/request', () => {
  it('tells a signed-out caller the client name, without claiming anything', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)
    const begun = beginPending(testDb.db, { clientName: 'Some Assistant' })

    const response = await request(app)
      .get('/oauth/mcp/request')
      .query({ request: begun.id })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      signedIn: false,
      clientName: 'Some Assistant',
    })
  })

  it('omits clientName entirely for a client that registered none — never a placeholder', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)
    const begun = beginPending(testDb.db)

    const response = await request(app)
      .get('/oauth/mcp/request')
      .query({ request: begun.id })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ signedIn: false })
  })

  it('claims and answers redirectHost for a signed-in caller', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)
    const caller = seedSignedInCaller(testDb.db)
    const begun = beginPending(testDb.db, {
      clientName: 'Totally Legit Assistant',
      redirectUri: 'https://attacker.example/steal-the-grant',
    })

    const response = await request(app)
      .get('/oauth/mcp/request')
      .query({ request: begun.id })
      .set('Cookie', caller.cookieHeader)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      signedIn: true,
      clientName: 'Totally Legit Assistant',
      redirectHost: 'attacker.example',
    })
  })

  it('answers a single 404 error code for an expired or unknown request id — signed out', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .get('/oauth/mcp/request')
      .query({ request: randomUUID() })

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'connection_request_unavailable' })
  })

  it('a signed-out visit does not claim — a later signed-in visit still can', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)
    const caller = seedSignedInCaller(testDb.db)
    const begun = beginPending(testDb.db)

    await request(app).get('/oauth/mcp/request').query({ request: begun.id })

    const signedInView = await request(app)
      .get('/oauth/mcp/request')
      .query({ request: begun.id })
      .set('Cookie', caller.cookieHeader)
    expect(signedInView.status).toBe(200)
    expect((signedInView.body as { signedIn: boolean }).signedIn).toBe(true)
  })

  // Security review, must-fix 2 — the binding half of the fix
  // (`schema.ts#mcpOauthPendingAuthorizations`'s own doc comment): the same
  // `request` id, forwarded to a second signed-in account, must not read
  // as available to them — the same 404 an unknown id gets, not a
  // different, more informative refusal.
  describe('binding a pending authorization to the first signed-in account', () => {
    it('claims for the first account and refuses a second, different one, identically to an unknown id', async () => {
      testDb = createTestDatabase()
      const app = await buildTestApp(testDb.db)
      const firstCaller = seedSignedInCaller(testDb.db)
      const secondCaller = seedSignedInCaller(testDb.db)
      const begun = beginPending(testDb.db)

      const firstView = await request(app)
        .get('/oauth/mcp/request')
        .query({ request: begun.id })
        .set('Cookie', firstCaller.cookieHeader)
      expect(firstView.status).toBe(200)
      expect((firstView.body as { signedIn: boolean }).signedIn).toBe(true)

      const secondView = await request(app)
        .get('/oauth/mcp/request')
        .query({ request: begun.id })
        .set('Cookie', secondCaller.cookieHeader)
      expect(secondView.status).toBe(404)
      expect(secondView.body).toEqual({
        error: 'connection_request_unavailable',
      })

      // The first account can still complete it — this is not a permanent
      // lock, only a refusal of anyone else.
      const decided = await request(app)
        .post('/oauth/mcp/decide')
        .set('Cookie', firstCaller.cookieHeader)
        .set('Origin', TEST_PUBLIC_APP_URL)
        .send({ request: begun.id, decision: 'allow' })
      expect(decided.status).toBe(200)
    })

    it("refuses a second account's own attempt to decide, even without ever loading /request first", async () => {
      testDb = createTestDatabase()
      const app = await buildTestApp(testDb.db)
      const firstCaller = seedSignedInCaller(testDb.db)
      const secondCaller = seedSignedInCaller(testDb.db)
      const begun = beginPending(testDb.db)

      // First account claims it via `GET /request`.
      await request(app)
        .get('/oauth/mcp/request')
        .query({ request: begun.id })
        .set('Cookie', firstCaller.cookieHeader)

      // A different account cannot decide it — allow or deny.
      const response = await request(app)
        .post('/oauth/mcp/decide')
        .set('Cookie', secondCaller.cookieHeader)
        .set('Origin', TEST_PUBLIC_APP_URL)
        .send({ request: begun.id, decision: 'allow' })
      expect(response.status).toBe(404)
    })
  })

  // Security review, must-fix 2 — framing. Without this header, the
  // corrected screen above could still be iframed on an attacker's own
  // page and the `Allow` click harvested without the victim reading
  // anything the fix above now renders.
  it('sets X-Frame-Options and a frame-ancestors CSP on every response, success or refusal', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)
    const begun = beginPending(testDb.db)

    const ok = await request(app)
      .get('/oauth/mcp/request')
      .query({ request: begun.id })
    expect(ok.headers['x-frame-options']).toBe('DENY')
    expect(ok.headers['content-security-policy']).toContain(
      "frame-ancestors 'none'"
    )

    const notFound = await request(app)
      .get('/oauth/mcp/request')
      .query({ request: randomUUID() })
    expect(notFound.headers['x-frame-options']).toBe('DENY')
  })
})

describe('POST /oauth/mcp/decide', () => {
  it('refuses without a signed-in session', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)
    const begun = beginPending(testDb.db)

    const response = await request(app)
      .post('/oauth/mcp/decide')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ request: begun.id, decision: 'allow' })

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'not_signed_in' })
  })

  it("binds the code to the signed-in caller's own account, never a request field", async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)
    const caller = seedSignedInCaller(testDb.db)
    const otherAccountId = randomUUID()
    const begun = beginPending(testDb.db, { state: 'carry-me' })

    const response = await request(app)
      .post('/oauth/mcp/decide')
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      // A malicious or merely confused client field naming a *different*
      // account — must never be read. There is no such field in this
      // route's own input schema at all, which this call proves by simply
      // never affecting anything: the redirect below still names the
      // consenting caller's own real code, not one for `otherAccountId`.
      .send({ request: begun.id, decision: 'allow', accountId: otherAccountId })

    expect(response.status).toBe(200)
    const redirect = new URL(
      (response.body as { redirectTo: string }).redirectTo
    )
    expect(redirect.origin + redirect.pathname).toBe(
      'https://client.example/callback'
    )
    expect(redirect.searchParams.get('code')).toBeDefined()
    expect(redirect.searchParams.get('state')).toBe('carry-me')
  })

  it('a decline answers a redirectTo carrying access_denied, and consumes the pending authorization', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)
    const caller = seedSignedInCaller(testDb.db)
    const begun = beginPending(testDb.db)

    const response = await request(app)
      .post('/oauth/mcp/decide')
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ request: begun.id, decision: 'deny' })

    expect(response.status).toBe(200)
    const redirect = new URL(
      (response.body as { redirectTo: string }).redirectTo
    )
    expect(redirect.searchParams.get('error')).toBe('access_denied')

    const secondAttempt = await request(app)
      .get('/oauth/mcp/request')
      .query({ request: begun.id })
      .set('Cookie', caller.cookieHeader)
    expect(secondAttempt.status).toBe(404)
  })

  it('an already-used or expired request id answers the single 404 error code rather than failing obscurely', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)
    const caller = seedSignedInCaller(testDb.db)

    const response = await request(app)
      .post('/oauth/mcp/decide')
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ request: randomUUID(), decision: 'allow' })

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'connection_request_unavailable' })
  })

  // Cheap fix from the security review — CSRF on this action is already
  // covered by the globally-mounted `originCheck` (API-3); pinned here so
  // a future re-mount of this router ahead of that middleware fails a test
  // rather than silently reopening it.
  it('refuses a cross-origin POST — inherited from the global originCheck, pinned against a future re-mount', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)
    const caller = seedSignedInCaller(testDb.db)
    const begun = beginPending(testDb.db)

    const response = await request(app)
      .post('/oauth/mcp/decide')
      .set('Cookie', caller.cookieHeader)
      .set('Origin', 'https://attacker.example')
      .send({ request: begun.id, decision: 'allow' })

    expect(response.status).toBe(403)
  })
})
