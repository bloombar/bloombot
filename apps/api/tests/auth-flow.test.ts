/**
 * Auth flows end to end, through HTTP (AUTH-1, AUTH-3, API-2): request a
 * sign-in link (captured by the recording mail port), redeem it, receive a
 * session cookie with every attribute API-2 requires, call "who am I", sign
 * out, and confirm the session is dead server-side, not merely that the
 * cookie was cleared. Also proves AUTH-3's "rotated on sign-in": a second
 * redemption for the same address ends the first session's token.
 */

import { randomUUID } from 'node:crypto'

import { RecordingEmailSender, validateSession } from '@bloombot/auth'
import { accounts, organizations, people } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import {
  buildTestApp,
  createFakeGoogleVerifier,
  TEST_PUBLIC_APP_URL,
} from './helpers/build-test-app.js'
import { seedSignedInCaller } from './helpers/seed.js'
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
    const app = await buildTestApp(testDb.db, { emailSender })

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

    // 3. "Who am I" — signed in, and (must-fix 9 of the API-1..6 rework)
    //    carrying the organization id every action URL needs
    //    (`POST /organizations/:organizationId/actions/:name`).
    const me = await request(app).get('/auth/me').set('Cookie', cookieHeader)
    expect(me.status).toBe(200)
    const meAccount = (
      me.body as {
        account: {
          id: string
          memberships: {
            organizationId: string
            organizationName: string
            role: string
          }[]
        } | null
      }
    ).account
    expect(meAccount).not.toBeNull()
    expect(meAccount!.memberships).toHaveLength(1)
    expect(meAccount!.memberships[0]).toMatchObject({ role: 'owner' })
    expect(meAccount!.memberships[0]!.organizationId).toBeTruthy()
    // TEN-7: a first-time sign-in's personal organization is named after the
    // account — `displayNameFromEmail('student@example.edu')`
    // (`@bloombot/auth`'s `sign-in.ts`) — not an opaque id, and `/auth/me`
    // (D-22's gap 1) is where the panel reads that name from.
    expect(meAccount!.memberships[0]!.organizationName).toBe('Student')

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
    const app = await buildTestApp(testDb.db, { emailSender })

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

// Must-fix 2 of the API-1..6 rework: `/auth/google` had no test at all — the
// default fake verifier (`build-test-app.ts`) always returns `ok: false`, so
// the success path, the cookie attributes and the 401 path were all
// unexercised. Every test below supplies its own verifier so the success
// path is actually reached.
describe('POST /auth/google (AUTH-2, API-2)', () => {
  it('signs in with a verified identity: 200, a full-attribute session cookie, and "who am I" reflects it', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db, {
      googleVerifier: createFakeGoogleVerifier({
        ok: true,
        identity: {
          subject: 'google-subject-1',
          email: 'instructor@example.edu',
          emailVerified: true,
        },
      }),
    })

    const response = await request(app)
      .post('/auth/google')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ idToken: 'fake-id-token' })

    expect(response.status).toBe(200)
    expect((response.body as { accountId: string }).accountId).toBeTruthy()

    const setCookie = response.headers['set-cookie'] as unknown as string[]
    const cookieLine = setCookie.find((header) =>
      header.startsWith(`${SESSION_COOKIE_NAME}=`)
    )!
    expect(cookieLine).toContain('HttpOnly')
    expect(cookieLine).toContain('Secure')
    expect(cookieLine).toContain('SameSite=Lax')
    expect(cookieLine).toContain('Expires=')
    expect(cookieLine).toContain('Path=/')

    const cookieHeader = `${SESSION_COOKIE_NAME}=${sessionCookieValue(setCookie)}`
    const me = await request(app).get('/auth/me').set('Cookie', cookieHeader)
    expect((me.body as { account: { id: string } | null }).account?.id).toBe(
      (response.body as { accountId: string }).accountId
    )
  })

  it('rotates the session on a second Google sign-in: the old token stops validating (must-fix 2)', async () => {
    testDb = createTestDatabase()
    const identity = {
      subject: 'google-subject-2',
      email: 'returning-google@example.edu',
      emailVerified: true,
    }
    const app = await buildTestApp(testDb.db, {
      googleVerifier: createFakeGoogleVerifier({ ok: true, identity }),
    })

    const first = await request(app)
      .post('/auth/google')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ idToken: 'fake-id-token' })
    const firstToken = sessionCookieValue(
      first.headers['set-cookie'] as unknown as string[]
    )!
    expect(validateSession(firstToken, testDb.db)).toBeDefined()

    const second = await request(app)
      .post('/auth/google')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ idToken: 'fake-id-token' })
    const secondToken = sessionCookieValue(
      second.headers['set-cookie'] as unknown as string[]
    )!

    // The token an attacker might have captured from the first sign-in no
    // longer validates — the whole point of rotating on sign-in.
    expect(validateSession(firstToken, testDb.db)).toBeUndefined()
    expect(validateSession(secondToken, testDb.db)).toBeDefined()
  })

  it('refuses with 401 when the verifier rejects the token', async () => {
    testDb = createTestDatabase()
    // `createFakeGoogleVerifier()` with no argument defaults to `ok: false`.
    const app = await buildTestApp(testDb.db, {
      googleVerifier: createFakeGoogleVerifier(),
    })

    const response = await request(app)
      .post('/auth/google')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ idToken: 'not-a-real-token' })

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'invalid_token' })
    expect(response.headers['set-cookie']).toBeUndefined()
  })
})

// Must-fix 3 of the API-1..6 rework: `z.string().min(1)` let a mistyped
// address reach `issueSignInToken`, which threw a `ZodError` — a value with
// no `code` — and `middleware/errors.ts` answered `500`, not a `400`.
describe('POST /auth/request-link — malformed address (AUTH-1)', () => {
  it('is a 400 carrying field errors, not a 500', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .post('/auth/request-link')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ email: 'not-an-email' })

    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ error: 'invalid_request' })
    expect(Array.isArray((response.body as { issues: unknown[] }).issues)).toBe(
      true
    )
    expect(
      (response.body as { issues: unknown[] }).issues.length
    ).toBeGreaterThan(0)
  })
})

// AUTH-5's must-fix 1, proven through the HTTP surface a real deployment
// actually sees: a mail port that throws must answer honestly (a 500, not
// the ordinary 204) and must not lock the address out for the rest of the
// token's own lifetime — the exact bug a reviewer reproduced against a
// running production API (a relay blip, then every retry answering 204
// with nothing ever sent).
describe('POST /auth/request-link — the mail port fails to send (AUTH-5)', () => {
  it('answers 500, not 204, and a retry with a working sender still succeeds', async () => {
    testDb = createTestDatabase()
    const failingSender = {
      send: () => Promise.reject(new Error('relay unreachable')),
    }
    const failingApp = await buildTestApp(testDb.db, {
      emailSender: failingSender,
    })

    const failed = await request(failingApp)
      .post('/auth/request-link')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ email: 'victim@example.edu' })
    expect(failed.status).toBe(500)

    // The retry this whole fix exists for: a *different* app instance
    // (same database, a working sender this time — standing in for the
    // relay coming back) actually sends, rather than the address staying
    // locked out for the token's own fifteen-minute lifetime.
    const workingSender = new RecordingEmailSender()
    const workingApp = await buildTestApp(testDb.db, {
      emailSender: workingSender,
    })
    const retried = await request(workingApp)
      .post('/auth/request-link')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ email: 'victim@example.edu' })
    expect(retried.status).toBe(204)
    expect(workingSender.sent).toHaveLength(1)
  })
})

// Cheap-fix 8 of the API-1..6 rework: `packages/db`'s own `sessions.test.ts`
// already proves `validateSession` refuses a disabled account's session —
// this is the same property, but through the HTTP surface: nothing before
// this asserted that `sessionMiddleware` (which every route reads
// `req.session` from) actually carries that refusal all the way up to a
// response, rather than, say, only being true of the raw repo call.
describe('a disabled account (AUTH-3, API-2)', () => {
  it('its session cookie no longer authenticates, over HTTP', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const app = await buildTestApp(testDb.db)

    // Confirm the session works before disabling, so the refusal below is
    // actually caused by disabling the account, not some other mistake.
    const before = await request(app)
      .get('/auth/me')
      .set('Cookie', caller.cookieHeader)
    expect(
      (before.body as { account: { id: string } | null }).account?.id
    ).toBe(caller.accountId)

    accounts.disableAccount(caller.accountId, testDb.db)

    const after = await request(app)
      .get('/auth/me')
      .set('Cookie', caller.cookieHeader)
    expect(after.status).toBe(200)
    expect(
      (after.body as { account: { id: string } | null }).account
    ).toBeNull()

    // And an authenticated action route treats it as anonymous too — the
    // same 401 API-1 gives a request with no cookie at all.
    const dispatch = await request(app)
      .post(`/organizations/${caller.organizationId}/actions/projects.create`)
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ name: 'Should Not Be Created' })
    expect(dispatch.status).toBe(401)
  })
})

// LINK-10: `GET /auth/me` also names every organization this account has a
// *connected* person in but no membership — a student reaching the
// institution's own organization, not an administrator there.
// `apps/api/tests/routes/person-link.test.ts`'s own acceptance test proves
// this end to end starting from a real, roster-admitted `discord`-surface
// person connected through the real HTTP endpoints; this file's own test
// proves the read surface's own shape directly — the exclusion of an
// organization already reported as a membership in particular, which that
// slower, full acceptance test does not happen to exercise (the account it
// drives has no membership in the institution's organization at all).
describe('GET /auth/me — connectedOrganizations (LINK-10)', () => {
  it('names a connected-but-not-a-member organization, and never repeats one already reported as a membership', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db, {
      organizationName: "The student's own organization",
    })
    const app = await buildTestApp(testDb.db)

    const institutionOrganizationId = randomUUID()
    organizations.createOrganization(
      institutionOrganizationId,
      { name: 'A University', isPersonal: false },
      testDb.db
    )
    // The real proof step (LINK-3) — `connectIdentity`, not a raw column
    // write — standing in for what `/discord/confirm` does once Discord's
    // OAuth round trip completes.
    const survivor = people.createPerson(
      institutionOrganizationId,
      {},
      testDb.db
    )
    const connected = people.connectIdentity(
      institutionOrganizationId,
      survivor.id,
      { surface: 'web', externalId: caller.accountId },
      testDb.db
    )
    expect(connected).toBeDefined()

    // The exclusion this test is named for only fires when the caller has a
    // connected person in an organization they are ALSO a member of — and a
    // real sign-in produces exactly that, because `createConnectedWebPerson`
    // connects the account's own person in its own personal organization.
    // `seedSignedInCaller` builds the account directly rather than through
    // sign-in, so without this the filter is never exercised and removing it
    // from `routes/auth.ts` leaves the whole suite green.
    //
    // What it costs when the filter is gone: `OrganizationSwitcher` builds
    // its options from both lists, so a brand-new single-organization user
    // gets a dropdown offering "X (owner)" and "X (connected)" — the same
    // organization twice, two React children sharing a key — where they
    // should see a plain label.
    const ownPerson = people.createPerson(caller.organizationId, {}, testDb.db)
    expect(
      people.connectIdentity(
        caller.organizationId,
        ownPerson.id,
        { surface: 'web', externalId: caller.accountId },
        testDb.db
      )
    ).toBeDefined()

    const me = await request(app)
      .get('/auth/me')
      .set('Cookie', caller.cookieHeader)
    expect(me.status).toBe(200)
    const account = (
      me.body as {
        account: {
          memberships: { organizationId: string }[]
          connectedOrganizations: {
            organizationId: string
            organizationName: string
          }[]
        } | null
      }
    ).account
    expect(account).not.toBeNull()
    // Only the account's own organization is a membership...
    expect(account!.memberships.map((m) => m.organizationId)).toEqual([
      caller.organizationId,
    ])
    // ...and the institution's is reported as connected, named, never as a
    // second membership.
    expect(account!.connectedOrganizations).toEqual([
      {
        organizationId: institutionOrganizationId,
        organizationName: 'A University',
      },
    ])
  })

  it('an organization with only an unconnected person (PPL-3s own "created on first sight" case) is not reported', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const app = await buildTestApp(testDb.db)

    const otherOrganizationId = randomUUID()
    organizations.createOrganization(
      otherOrganizationId,
      { name: 'Never Connected Here', isPersonal: false },
      testDb.db
    )
    // Created, but never proven — `connectedAt` stays null.
    people.resolvePersonByIdentity(
      otherOrganizationId,
      { surface: 'web', externalId: caller.accountId },
      testDb.db
    )

    const me = await request(app)
      .get('/auth/me')
      .set('Cookie', caller.cookieHeader)
    const account = (
      me.body as {
        account: { connectedOrganizations: unknown[] } | null
      }
    ).account
    expect(account!.connectedOrganizations).toEqual([])
  })
})
