/**
 * WEB-72/DATA-7 — `routes/account.ts`: an account holder deletes their own
 * account. Unscoped, over HTTP (`routes/account.ts`'s own module comment
 * has why) — mirrors `tests/auth-flow.test.ts`'s own "dies on sign-out"
 * shape for the identical "ends the session server-side" guarantee, plus
 * DATA-7's own "marks, does not remove" and DATA-9's "answers nothing
 * afterward".
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import { accounts, people } from '@bloombot/db'

import { buildTestApp, TEST_PUBLIC_APP_URL } from '../helpers/build-test-app.js'
import { SESSION_COOKIE_NAME } from '../../src/middleware/session.js'
import { seedSignedInCaller } from '../helpers/seed.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('POST /account/delete (WEB-72/DATA-7)', () => {
  it('a signed-out caller is refused (401), and nothing is deleted', async () => {
    testDb = createTestDatabase()
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .post('/account/delete')
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'not_signed_in' })
  })

  it("deletes the caller's own account, ends every one of its sessions, and clears this browser's own cookie", async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .post('/account/delete')
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)

    expect(response.status).toBe(204)

    // DATA-9 — an ordinary read excludes it: gone from the product the
    // moment it is marked, not merely scheduled to go.
    expect(accounts.getAccountById(caller.accountId, testDb.db)).toBeUndefined()

    // The cookie this very response set is cleared — the same
    // `clearSessionCookie` call `POST /auth/sign-out` already makes
    // (`tests/auth-flow.test.ts`'s own "dies on sign-out").
    const setCookie = response.headers['set-cookie'] as unknown as
      string[] | undefined
    const cleared = setCookie?.find((header) =>
      header.startsWith(`${SESSION_COOKIE_NAME}=;`)
    )
    expect(cleared).toBeDefined()

    // And the session this very cookie named no longer validates —
    // `GET /auth/me` reports the caller signed out, not merely that this
    // one response cleared its own cookie.
    const me = await request(app)
      .get('/auth/me')
      .set('Cookie', caller.cookieHeader)
    expect(me.status).toBe(200)
    expect((me.body as { account: unknown }).account).toBeNull()
  })

  it('deletes only the caller’s own account — another account in the same organization survives', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const bystander = accounts.createAccount(
      caller.organizationId,
      {
        email: `bystander-${randomUUID()}@example.edu`,
        displayName: 'Bystander',
        role: 'instructor',
      },
      testDb.db
    )
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .post('/account/delete')
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
    expect(response.status).toBe(204)

    expect(accounts.getAccountById(caller.accountId, testDb.db)).toBeUndefined()
    expect(accounts.getAccountById(bystander.id, testDb.db)).toBeDefined()
  })

  // Deletes no `people` row — an account and a person are distinct
  // concepts (`packages/db/src/repos/accounts.ts#softDeleteAccount`'s own
  // doc comment: an account carries no child table this package's own
  // deletable set names), so a person this account happens to be connected
  // to is untouched by deleting the account alone.
  it('does not touch any person this account is connected to', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const person = people.createPerson(
      caller.organizationId,
      { displayName: 'Connected Person' },
      testDb.db
    )
    people.connectIdentity(
      caller.organizationId,
      person.id,
      { surface: 'web', externalId: caller.accountId },
      testDb.db
    )
    const app = await buildTestApp(testDb.db)

    const response = await request(app)
      .post('/account/delete')
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
    expect(response.status).toBe(204)

    expect(
      people.getPerson(caller.organizationId, person.id, testDb.db)
    ).toBeDefined()
  })
})
