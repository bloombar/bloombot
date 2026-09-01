import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  accounts,
  closeDatabase,
  discordInstallStates,
  openDatabase,
  organizations,
} from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** One organization and one account to begin an install attempt against. */
function seedOrgAndAccount(testDatabase: TestDatabase) {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Org', isPersonal: false },
    testDatabase.db
  )
  const account = accounts.createAccount(
    organizationId,
    { email: 'installer@example.edu', displayName: 'Installer', role: 'owner' },
    testDatabase.db
  )
  return { organizationId, accountId: account.id }
}

describe('discord-install-states repo (TEN-4)', () => {
  it('creates a row and stores the verifier in plain text, not hashed', () => {
    testDb = createTestDatabase()
    const { organizationId, accountId } = seedOrgAndAccount(testDb)

    const row = discordInstallStates.createInstallState(
      {
        organizationId,
        accountId,
        stateHash: 'a-state-hash',
        codeVerifier: 'the-plaintext-verifier',
        expiresAt: Date.now() + 60_000,
      },
      testDb.db
    )

    expect(row).toMatchObject({
      organizationId,
      accountId,
      stateHash: 'a-state-hash',
      codeVerifier: 'the-plaintext-verifier',
      usedAt: null,
    })
  })

  it('consumes a state exactly once', () => {
    testDb = createTestDatabase()
    const { organizationId, accountId } = seedOrgAndAccount(testDb)
    discordInstallStates.createInstallState(
      {
        organizationId,
        accountId,
        stateHash: 'hash-1',
        codeVerifier: 'verifier-1',
        expiresAt: Date.now() + 60_000,
      },
      testDb.db
    )

    const first = discordInstallStates.consumeInstallState(
      'hash-1',
      Date.now(),
      testDb.db
    )
    const second = discordInstallStates.consumeInstallState(
      'hash-1',
      Date.now(),
      testDb.db
    )

    expect(first).toMatchObject({ organizationId, accountId })
    expect(second).toBeUndefined()
  })

  it('refuses a hash that was never issued', () => {
    testDb = createTestDatabase()
    expect(
      discordInstallStates.consumeInstallState(
        'nonexistent',
        Date.now(),
        testDb.db
      )
    ).toBeUndefined()
  })

  it('refuses an expired state', () => {
    testDb = createTestDatabase()
    const { organizationId, accountId } = seedOrgAndAccount(testDb)
    const now = Date.now()
    discordInstallStates.createInstallState(
      {
        organizationId,
        accountId,
        stateHash: 'hash-1',
        codeVerifier: 'verifier-1',
        expiresAt: now - 1,
      },
      testDb.db
    )

    expect(
      discordInstallStates.consumeInstallState('hash-1', now, testDb.db)
    ).toBeUndefined()
  })

  // The same single-conditional-`UPDATE` race proof `sign-in-tokens.test.ts`
  // runs for its own redemption — two connections presenting the same state
  // must resolve to exactly one winner.
  it('two connections consuming the same hash yield exactly one winner', () => {
    testDb = createTestDatabase()
    const { organizationId, accountId } = seedOrgAndAccount(testDb)
    const now = Date.now()
    discordInstallStates.createInstallState(
      {
        organizationId,
        accountId,
        stateHash: 'hash-1',
        codeVerifier: 'verifier-1',
        expiresAt: now + 60_000,
      },
      testDb.db
    )

    const connectionB = openDatabase(testDb.path)
    const resultA = discordInstallStates.consumeInstallState(
      'hash-1',
      Date.now(),
      testDb.db
    )
    const resultB = discordInstallStates.consumeInstallState(
      'hash-1',
      Date.now(),
      connectionB
    )
    closeDatabase(connectionB)

    const successes = [resultA, resultB].filter((r) => r !== undefined)
    expect(successes).toHaveLength(1)
  })
})
