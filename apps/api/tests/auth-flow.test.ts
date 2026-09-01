/**
 * Auth flows end to end, through HTTP (AUTH-1, AUTH-3, API-2): request a
 * sign-in link (captured by the recording mail port), redeem it, receive a
 * session cookie with every attribute API-2 requires, call "who am I", sign
 * out, and confirm the session is dead server-side, not merely that the
 * cookie was cleared. Also proves AUTH-3's "rotated on sign-in": a second
 * redemption for the same address ends the first session's token.
 */

import { RecordingEmailSender, validateSession } from '@bloombot/auth'
import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import { buildTestApp, TEST_PUBLIC_APP_URL } from './helpers/build-test-app.js'
import { SESSION_COOKIE_NAME } from '../src/middleware/session.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Pulls the value of `bloombot_session` out of a `set-cookie` header array, or `undefined`. */
function sessionCookieValue(setCookieHeaders: string[]): string | undefined {
  const line = setCookieHeaders.find((header) =>
    header.startsWith(`${SESSION_COOKIE_NAME}=`)
  )
  return line?.split(';')[0]?.split('=')[1]
}

describe('sign-in, "who am I", sign-out — end to end over HTTP', () => {
  it('requests a link, redeems it, receives a cookie, reports "who am I", then dies on sign-out', async () => {
    testDb = createTestDatabase()
    const emailSender = new RecordingEmailSender()
    const app = buildTestApp(testDb.db, { emailSender })

    // 1. Request a sign-in link — captured by the recording mail port, not
    //    a real transport.
    const requested = await request(app)
      .post('/auth/request-link')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ email: 'student@example.edu' })
    expect(requested.status).toBe(204)
    expect(emailSender.sent).toHaveLength(1)

    const emailedLink = emailSender.sent[0]!.body
    const token = emailedLink.split('/sign-in/')[1]?.trim()
    expect(token).toBeTruthy()

    // 2. Redeem it — receive a session cookie.
    const redeemed = await request(app)
      .post('/auth/redeem')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ token })
    expect(redeemed.status).toBe(200)
    const setCookie = redeemed.headers['set-cookie'] as unknown as string[]
    expect(setCookie).toBeDefined()
    const cookieLine = setCookie.find((header) =>
      header.startsWith(`${SESSION_COOKIE_NAME}=`)
    )!
    // API-2's full attribute set.
    expect(cookieLine).toContain('HttpOnly')
    expect(cookieLine).toContain('Secure')
    expect(cookieLine).toContain('SameSite=Lax')
    expect(cookieLine).toContain('Expires=')
    expect(cookieLine).toContain('Path=/')

    const sessionToken = sessionCookieValue(setCookie)!
    const cookieHeader = `${SESSION_COOKIE_NAME}=${sessionToken}`

    // 3. "Who am I" — signed in.
    const me = await request(app).get('/auth/me').set('Cookie', cookieHeader)
    expect(me.status).toBe(200)
    expect(
      (me.body as { account: { id: string } | null }).account
    ).not.toBeNull()

    // 4. Sign out — revokes server-side, not merely clears the cookie.
    const signOut = await request(app)
      .post('/auth/sign-out')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .set('Cookie', cookieHeader)
    expect(signOut.status).toBe(204)

    // The session no longer validates at all — checked directly against
    // `@bloombot/auth`, not only through the HTTP surface that wraps it.
    expect(validateSession(sessionToken, testDb.db)).toBeUndefined()

    // "Who am I" now reports anonymous, using the same (now-dead) cookie.
    const meAfter = await request(app)
      .get('/auth/me')
      .set('Cookie', cookieHeader)
    expect(meAfter.status).toBe(200)
    expect(
      (meAfter.body as { account: { id: string } | null }).account
    ).toBeNull()
  })

  it('rotates the session on a second sign-in: the old token stops validating', async () => {
    testDb = createTestDatabase()
    const emailSender = new RecordingEmailSender()
    const app = buildTestApp(testDb.db, { emailSender })

    async function requestAndRedeem(): Promise<string> {
      await request(app)
        .post('/auth/request-link')
        .set('Origin', TEST_PUBLIC_APP_URL)
        .send({ email: 'returning@example.edu' })
      const link = emailSender.sent[emailSender.sent.length - 1]!.body
      const token = link.split('/sign-in/')[1]!.trim()
      const redeemed = await request(app)
        .post('/auth/redeem')
        .set('Origin', TEST_PUBLIC_APP_URL)
        .send({ token })
      const setCookie = redeemed.headers['set-cookie'] as unknown as string[]
      return sessionCookieValue(setCookie)!
    }

    const firstToken = await requestAndRedeem()
    expect(validateSession(firstToken, testDb.db)).toBeDefined()

    const secondToken = await requestAndRedeem()

    // The first session is dead — rotated away by the second sign-in.
    expect(validateSession(firstToken, testDb.db)).toBeUndefined()
    // The second is the one now live.
    expect(validateSession(secondToken, testDb.db)).toBeDefined()
  })
})
