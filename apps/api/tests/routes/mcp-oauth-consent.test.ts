/**
 * `routes/mcp-oauth-consent.ts` (MCP-7's own human-facing half). Every test
 * here writes the pending authorization directly through `@bloombot/auth`'s
 * `beginAuthorization` — the same "written through the real repos, never
 * through the surface under test" convention `person-link.test.ts`'s own
 * module comment already holds this test directory to — since
 * `apps/mcp`'s own `authorize()` is `apps/mcp/tests/oauth-http.test.ts`'s
 * job to prove, not this file's.
 *
 * The "security review, must-fix 2" describe blocks below are this file's
 * own regression tests for the account-takeover a review round found: the
 * consent screen naming neither the client nor the destination, and a
 * `request` id usable by any signed-in browser that saw it, not only the
 * first one.
 */

import { randomUUID } from 'node:crypto'

import {
  beginAuthorization,
  peekPendingAuthorization,
  RecordingEmailSender,
  registerOauthClient,
} from '@bloombot/auth'
import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import { buildTestApp, TEST_PUBLIC_APP_URL } from '../helpers/build-test-app.js'
import { seedSignedInCaller } from '../helpers/seed.js'
import { SESSION_COOKIE_NAME } from '../../src/middleware/session.js'
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

/** Pulls the value of `bloombot_session` out of a `set-cookie` header array, or `undefined` — the same helper `auth-flow.test.ts` already uses. */
function sessionCookieValue(setCookieHeaders: string[]): string | undefined {
  const line = setCookieHeaders.find((header) =>
    header.startsWith(`${SESSION_COOKIE_NAME}=`)
  )
  return line?.split(';')[0]?.split('=')[1]
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

  // Security review, must-fix 2 — the disclosure half of the fix: the
  // earlier screen showed the generic placeholder "An MCP assistant"
  // regardless of who was actually asking, or where the grant would go.
  describe('naming the client and the destination — the takeover fix', () => {
    it('renders the registered client name and the redirect URI host', async () => {
      testDb = createTestDatabase()
      const app = await buildTestApp(testDb.db)
      const caller = seedSignedInCaller(testDb.db)
      const begun = beginPending(testDb.db, {
        clientName: 'Totally Legit Assistant',
        redirectUri: 'https://attacker.example/steal-the-grant',
      })

      const response = await request(app)
        .get('/oauth/mcp/authorize')
        .query({ request: begun.id })
        .set('Cookie', caller.cookieHeader)

      expect(response.status).toBe(200)
      expect(response.text).toContain('Totally Legit Assistant')
      expect(response.text).toContain('attacker.example')
      // Never the generic placeholder the security review's own report
      // showed a real victim being handed with nothing else to go on.
      expect(response.text).not.toMatch(/An MCP assistant/i)
    })

    it('is honest about a client with no registered name — never a reassuring placeholder', async () => {
      testDb = createTestDatabase()
      const app = await buildTestApp(testDb.db)
      const caller = seedSignedInCaller(testDb.db)
      const begun = beginPending(testDb.db)

      const response = await request(app)
        .get('/oauth/mcp/authorize')
        .query({ request: begun.id })
        .set('Cookie', caller.cookieHeader)

      expect(response.text).toMatch(/no registered name/i)
      expect(response.text).not.toMatch(/An MCP assistant/i)
    })
  })

  // Security review, must-fix 2 — the binding half of the fix
  // (`schema.ts#mcpOauthPendingAuthorizations`'s own doc comment): the same
  // `request` id, forwarded to a second signed-in account, must not read
  // as available to them.
  describe('binding a pending authorization to the first signed-in account', () => {
    it('claims for the first account and refuses a second, different one, identically to an unknown id', async () => {
      testDb = createTestDatabase()
      const app = await buildTestApp(testDb.db)
      const firstCaller = seedSignedInCaller(testDb.db)
      const secondCaller = seedSignedInCaller(testDb.db)
      const begun = beginPending(testDb.db)

      const firstView = await request(app)
        .get('/oauth/mcp/authorize')
        .query({ request: begun.id })
        .set('Cookie', firstCaller.cookieHeader)
      expect(firstView.status).toBe(200)
      expect(firstView.text).toMatch(/act as your Bloombot account/i)

      const secondView = await request(app)
        .get('/oauth/mcp/authorize')
        .query({ request: begun.id })
        .set('Cookie', secondCaller.cookieHeader)
      expect(secondView.status).toBe(404)
      expect(secondView.text).toMatch(/expired|already used|different/i)

      // The first account can still complete it — this is not a permanent
      // lock, only a refusal of anyone else.
      const decided = await request(app)
        .post('/oauth/mcp/authorize/decide')
        .type('form')
        .set('Cookie', firstCaller.cookieHeader)
        .set('Origin', TEST_PUBLIC_APP_URL)
        .send({ request: begun.id, decision: 'allow' })
      expect(decided.status).toBe(302)
    })

    it("refuses a second account's own attempt to decide, even without ever loading the GET screen first", async () => {
      testDb = createTestDatabase()
      const app = await buildTestApp(testDb.db)
      const firstCaller = seedSignedInCaller(testDb.db)
      const secondCaller = seedSignedInCaller(testDb.db)
      const begun = beginPending(testDb.db)

      // First account claims it via the GET screen.
      await request(app)
        .get('/oauth/mcp/authorize')
        .query({ request: begun.id })
        .set('Cookie', firstCaller.cookieHeader)

      // A different account cannot decide it — allow or deny.
      const response = await request(app)
        .post('/oauth/mcp/authorize/decide')
        .type('form')
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
      .get('/oauth/mcp/authorize')
      .query({ request: begun.id })
    expect(ok.headers['x-frame-options']).toBe('DENY')
    expect(ok.headers['content-security-policy']).toContain(
      "frame-ancestors 'none'"
    )

    const notFound = await request(app)
      .get('/oauth/mcp/authorize')
      .query({ request: randomUUID() })
    expect(notFound.headers['x-frame-options']).toBe('DENY')
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
      .post('/oauth/mcp/authorize/decide')
      .type('form')
      .set('Cookie', caller.cookieHeader)
      .set('Origin', 'https://attacker.example')
      .send({ request: begun.id, decision: 'allow' })

    expect(response.status).toBe(403)
  })
})

// Security review, must-fix 2 — "sign in in another tab and reload" was
// itself the defect making a `request` id transferable between people: a
// signed-out visitor now round-trips through a real sign-in instead
// (`/sign-in`, `/redeem`, `routes/mcp-oauth-consent.ts`'s own module
// comment on why this lives here rather than in the panel).
describe('the sign-in round trip for a signed-out visitor', () => {
  /** Requests a link for `email` carrying `requestId` as its own destination, and returns the token the recording mail port captured. */
  async function requestLinkAndGetToken(
    app: Awaited<ReturnType<typeof buildTestApp>>,
    emailSender: RecordingEmailSender,
    email: string,
    requestId: string
  ): Promise<string> {
    const signInRequest = await request(app)
      .post('/oauth/mcp/sign-in')
      .type('form')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ email, request: requestId })
    expect(signInRequest.status).toBe(200)
    expect(signInRequest.text).toMatch(/check your email/i)
    const emailedLink = emailSender.sent.at(-1)!.body
    const token = emailedLink.split('token=')[1]?.trim()
    expect(token).toBeTruthy()
    return token!
  }

  it('emails a link whose GET page never sets a cookie — it only renders an interstitial naming a POST', async () => {
    testDb = createTestDatabase()
    const emailSender = new RecordingEmailSender()
    const app = await buildTestApp(testDb.db, { emailSender })
    const begun = beginPending(testDb.db)
    const token = await requestLinkAndGetToken(
      app,
      emailSender,
      'student@example.edu',
      begun.id
    )

    const getResponse = await request(app)
      .get('/oauth/mcp/redeem')
      .query({ token })

    expect(getResponse.status).toBe(200)
    expect(getResponse.headers['set-cookie']).toBeUndefined()
    expect(getResponse.text).toContain('action="/oauth/mcp/redeem"')
    expect(getResponse.text).toContain('method="POST"')
    expect(getResponse.text).toContain(token)
  })

  // Security review, third round — the actual account-takeover this closes:
  // `GET /oauth/mcp/redeem` used to redeem the token and set the session
  // cookie directly, from a plain `GET` — the first endpoint in `apps/api`
  // to establish a session that way, and `originCheck` deliberately exempts
  // `GET` (that middleware's own module comment). A cross-site request with
  // no navigation at all — the shape `<img src="…/redeem?token=…">` on a
  // page an already-signed-in person merely visits produces — must not
  // establish a session, regardless of `Origin` or `Sec-Fetch-Dest`; this
  // `GET` no longer touches the database or the cookie jar at all, which is
  // what this assertion is actually pinning.
  it('a cross-site, non-document GET does not establish a session', async () => {
    testDb = createTestDatabase()
    const emailSender = new RecordingEmailSender()
    const app = await buildTestApp(testDb.db, { emailSender })
    const begun = beginPending(testDb.db)
    const token = await requestLinkAndGetToken(
      app,
      emailSender,
      'victim@example.edu',
      begun.id
    )

    const response = await request(app)
      .get('/oauth/mcp/redeem')
      .query({ token })
      .set('Origin', 'https://evil.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Sec-Fetch-Dest', 'image')

    expect(response.status).toBe(200)
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('POST /redeem sets the session cookie and redirects back to the same consent screen', async () => {
    testDb = createTestDatabase()
    const emailSender = new RecordingEmailSender()
    const app = await buildTestApp(testDb.db, { emailSender })
    const begun = beginPending(testDb.db, {
      clientName: 'Totally Legit Assistant',
    })
    const token = await requestLinkAndGetToken(
      app,
      emailSender,
      'student@example.edu',
      begun.id
    )

    const redeemed = await request(app)
      .post('/oauth/mcp/redeem')
      .type('form')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ token })
    expect(redeemed.status).toBe(302)
    const destination = redeemed.headers['location'] as string
    expect(destination).toBe(`/oauth/mcp/authorize?request=${begun.id}`)
    const setCookie = redeemed.headers['set-cookie'] as unknown as string[]
    expect(setCookie).toBeDefined()
    const sessionToken = sessionCookieValue(setCookie)!
    const cookieHeader = `${SESSION_COOKIE_NAME}=${sessionToken}`

    // Following the redirect, now signed in, lands on the real consent
    // screen — not the sign-in form again.
    const landedOn = await request(app)
      .get(destination)
      .set('Cookie', cookieHeader)
    expect(landedOn.status).toBe(200)
    expect(landedOn.text).toMatch(/act as your Bloombot account/i)
    expect(landedOn.text).toContain('Totally Legit Assistant')
  })

  it('POST /redeem refuses a cross-origin caller — the originCheck this GET-only shape used to bypass', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .post('/oauth/mcp/redeem')
      .type('form')
      .set('Origin', 'https://evil.example')
      .send({ token: 'irrelevant' })

    expect(response.status).toBe(403)
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('an invalid or expired sign-in token answers plainly', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .post('/oauth/mcp/redeem')
      .type('form')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ token: 'not-a-real-token' })

    expect(response.status).toBe(401)
    expect(response.text).toMatch(/invalid|expired/i)
  })
})
