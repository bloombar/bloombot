import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import { accounts, organizations, sessions } from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** One account for a session to belong to. */
function seedAccount(testDatabase: TestDatabase): string {
  const orgId = randomUUID()
  organizations.createOrganization(
    orgId,
    { name: 'Org', isPersonal: false },
    testDatabase.db
  )
  return accounts.createAccount(
    orgId,
    { email: 'a@example.edu', displayName: 'A', role: 'owner' },
    testDatabase.db
  ).id
}

describe('sessions repo (AUTH-3)', () => {
  it('creates a session row', () => {
    testDb = createTestDatabase()
    const accountId = seedAccount(testDb)

    const row = sessions.createSession(
      { accountId, tokenHash: 'hash-1', expiresAt: Date.now() + 60_000 },
      testDb.db
    )

    expect(row).toMatchObject({ accountId, tokenHash: 'hash-1' })
    expect(row.lastSeenAt).toBe(row.createdAt)
  })

  it('validates a session and touches lastSeenAt', () => {
    testDb = createTestDatabase()
    const accountId = seedAccount(testDb)
    sessions.createSession(
      { accountId, tokenHash: 'hash-1', expiresAt: Date.now() + 60_000 },
      testDb.db
    )

    const later = Date.now() + 5_000
    const validated = sessions.validateSession('hash-1', later, testDb.db)

    expect(validated).toMatchObject({ accountId })
    expect(validated?.lastSeenAt).toBe(later)
  })

  it('does not validate an expired session', () => {
    testDb = createTestDatabase()
    const accountId = seedAccount(testDb)
    const now = Date.now()
    sessions.createSession(
      { accountId, tokenHash: 'hash-1', expiresAt: now - 1 },
      testDb.db
    )

    expect(sessions.validateSession('hash-1', now, testDb.db)).toBeUndefined()
  })

  it('does not validate a revoked session', () => {
    testDb = createTestDatabase()
    const accountId = seedAccount(testDb)
    sessions.createSession(
      { accountId, tokenHash: 'hash-1', expiresAt: Date.now() + 60_000 },
      testDb.db
    )
    sessions.revokeSessionByHash('hash-1', testDb.db)

    expect(
      sessions.validateSession('hash-1', Date.now(), testDb.db)
    ).toBeUndefined()
  })

  it('revokeSessionByHash is a no-op the second time', () => {
    testDb = createTestDatabase()
    const accountId = seedAccount(testDb)
    sessions.createSession(
      { accountId, tokenHash: 'hash-1', expiresAt: Date.now() + 60_000 },
      testDb.db
    )

    const first = sessions.revokeSessionByHash('hash-1', testDb.db)
    const second = sessions.revokeSessionByHash('hash-1', testDb.db)

    expect(first).toMatchObject({ accountId })
    expect(second).toBeUndefined()
  })

  it('revokeAllSessionsForAccount revokes every active session and none of another account', () => {
    testDb = createTestDatabase()
    const accountA = seedAccount(testDb)
    const orgId = randomUUID()
    organizations.createOrganization(
      orgId,
      { name: 'Org B', isPersonal: false },
      testDb.db
    )
    const accountB = accounts.createAccount(
      orgId,
      { email: 'b@example.edu', displayName: 'B', role: 'owner' },
      testDb.db
    ).id

    sessions.createSession(
      { accountId: accountA, tokenHash: 'a-1', expiresAt: Date.now() + 60_000 },
      testDb.db
    )
    sessions.createSession(
      { accountId: accountA, tokenHash: 'a-2', expiresAt: Date.now() + 60_000 },
      testDb.db
    )
    sessions.createSession(
      { accountId: accountB, tokenHash: 'b-1', expiresAt: Date.now() + 60_000 },
      testDb.db
    )

    const revokedCount = sessions.revokeAllSessionsForAccount(
      accountA,
      testDb.db
    )

    expect(revokedCount).toBe(2)
    expect(
      sessions.validateSession('a-1', Date.now(), testDb.db)
    ).toBeUndefined()
    expect(
      sessions.validateSession('a-2', Date.now(), testDb.db)
    ).toBeUndefined()
    expect(
      sessions.validateSession('b-1', Date.now(), testDb.db)
    ).toMatchObject({ accountId: accountB })
  })
})
