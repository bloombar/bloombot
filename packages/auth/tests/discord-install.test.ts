/**
 * TEN-4 — the Discord install flow's OAuth+PKCE state: issued once,
 * redeemed once, and never recoverable from the database except for the
 * verifier, which is deliberately stored in plain text (see
 * `discord-install.ts`'s own module comment and docs/DECISIONS.md D-21).
 */

import { createHash, randomUUID } from 'node:crypto'

import {
  accounts,
  closeDatabase,
  discordInstallStates,
  openDatabase,
  organizations,
  schema,
} from '@bloombot/db'
import type { Database } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import {
  beginDiscordInstall,
  consumeDiscordInstallState,
  DEFAULT_INSTALL_STATE_TTL_MS,
} from '../src/discord-install.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** One organization and one signed-in-shaped account to begin an install against. */
function seedOrgAndAccount(db: Database) {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Org', isPersonal: false },
    db
  )
  const account = accounts.createAccount(
    organizationId,
    { email: 'installer@example.edu', displayName: 'Installer', role: 'owner' },
    db
  )
  return { organizationId, accountId: account.id }
}

describe('beginDiscordInstall', () => {
  it('returns a state and a code challenge, and never stores the state in plaintext', () => {
    testDb = createTestDatabase()
    const { organizationId, accountId } = seedOrgAndAccount(testDb.db)

    const begun = beginDiscordInstall(organizationId, accountId, testDb.db)

    expect(begun.state.length).toBeGreaterThan(20)
    expect(begun.expiresAt).toBeGreaterThan(Date.now())

    const rows = testDb.db.select().from(schema.discordInstallStates).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.stateHash).not.toBe(begun.state)
    expect(JSON.stringify(rows[0])).not.toContain(begun.state)
  })

  it('the returned codeChallenge is the S256 (base64url-SHA-256) hash of the stored, plaintext verifier', () => {
    testDb = createTestDatabase()
    const { organizationId, accountId } = seedOrgAndAccount(testDb.db)

    const begun = beginDiscordInstall(organizationId, accountId, testDb.db)

    const row = testDb.db.select().from(schema.discordInstallStates).get()
    expect(row?.codeVerifier).toBeDefined()
    const expectedChallenge = createHash('sha256')
      .update(row?.codeVerifier ?? '')
      .digest('base64url')
    expect(begun.codeChallenge).toBe(expectedChallenge)
  })

  it('defaults to a ten-minute expiry', () => {
    expect(DEFAULT_INSTALL_STATE_TTL_MS).toBe(10 * 60 * 1000)
  })

  // Cheap-fix 8 of the TEN-4..6 rework: a sweep on write, not a "one live
  // attempt" refusal — see `@bloombot/db`'s own
  // `deleteExpiredInstallStates` doc comment for why.
  it('sweeps every already-expired row before inserting its own — no unbounded growth from abandoned attempts', () => {
    testDb = createTestDatabase()
    const { organizationId, accountId } = seedOrgAndAccount(testDb.db)
    // Two abandoned, already-expired attempts from earlier — written
    // directly through the repo (not `beginDiscordInstall`, which would
    // sweep each one before the next existed to be counted).
    const now = Date.now()
    discordInstallStates.createInstallState(
      {
        organizationId,
        accountId,
        stateHash: 'expired-hash-1',
        codeVerifier: 'verifier-1',
        expiresAt: now - 1,
      },
      testDb.db
    )
    discordInstallStates.createInstallState(
      {
        organizationId,
        accountId,
        stateHash: 'expired-hash-2',
        codeVerifier: 'verifier-2',
        expiresAt: now - 1,
      },
      testDb.db
    )
    expect(
      testDb.db.select().from(schema.discordInstallStates).all()
    ).toHaveLength(2)

    // A third, live attempt begins.
    beginDiscordInstall(organizationId, accountId, testDb.db)

    // The two expired rows are gone; only the live one remains.
    const rows = testDb.db.select().from(schema.discordInstallStates).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.expiresAt).toBeGreaterThan(Date.now())
  })

  it('does not sweep a row that has not expired yet', () => {
    testDb = createTestDatabase()
    const { organizationId, accountId } = seedOrgAndAccount(testDb.db)
    beginDiscordInstall(organizationId, accountId, testDb.db)

    beginDiscordInstall(organizationId, accountId, testDb.db)

    expect(
      testDb.db.select().from(schema.discordInstallStates).all()
    ).toHaveLength(2)
  })
})

describe('consumeDiscordInstallState', () => {
  it('redeems a freshly begun install, returning the organization, account and verifier it began with', () => {
    testDb = createTestDatabase()
    const { organizationId, accountId } = seedOrgAndAccount(testDb.db)
    const begun = beginDiscordInstall(organizationId, accountId, testDb.db)
    const row = testDb.db.select().from(schema.discordInstallStates).get()

    const consumed = consumeDiscordInstallState(begun.state, testDb.db)

    expect(consumed).toEqual({
      organizationId,
      accountId,
      codeVerifier: row?.codeVerifier,
    })
  })

  it('cannot be redeemed a second time — a replayed state is refused', () => {
    testDb = createTestDatabase()
    const { organizationId, accountId } = seedOrgAndAccount(testDb.db)
    const begun = beginDiscordInstall(organizationId, accountId, testDb.db)

    const first = consumeDiscordInstallState(begun.state, testDb.db)
    const second = consumeDiscordInstallState(begun.state, testDb.db)

    expect(first).not.toBeUndefined()
    expect(second).toBeUndefined()
  })

  it('refuses an expired state', () => {
    testDb = createTestDatabase()
    const { organizationId, accountId } = seedOrgAndAccount(testDb.db)
    // Begun with a negative TTL: already expired the moment it is stored.
    const begun = beginDiscordInstall(organizationId, accountId, testDb.db, -1)

    expect(consumeDiscordInstallState(begun.state, testDb.db)).toBeUndefined()
  })

  it('refuses a state that was never issued, identically to a replayed or expired one — no oracle', () => {
    testDb = createTestDatabase()
    const { organizationId, accountId } = seedOrgAndAccount(testDb.db)
    const begun = beginDiscordInstall(organizationId, accountId, testDb.db)
    consumeDiscordInstallState(begun.state, testDb.db) // spend it

    const neverExisted = consumeDiscordInstallState(
      'made-up-state-value',
      testDb.db
    )
    const replayed = consumeDiscordInstallState(begun.state, testDb.db)

    expect(neverExisted).toBeUndefined()
    expect(replayed).toBeUndefined()
  })

  // The same race proof `tokens.test.ts` runs for AUTH-1's sign-in tokens —
  // two real connections against the same file, proving the redemption is a
  // single atomic statement.
  it('two concurrent redemptions of the same state yield exactly one success', () => {
    testDb = createTestDatabase()
    const { organizationId, accountId } = seedOrgAndAccount(testDb.db)
    const begun = beginDiscordInstall(organizationId, accountId, testDb.db)

    const connectionA = testDb.db
    const connectionB: Database = openDatabase(testDb.path)

    const resultA = consumeDiscordInstallState(begun.state, connectionA)
    const resultB = consumeDiscordInstallState(begun.state, connectionB)

    const successes = [resultA, resultB].filter((r) => r !== undefined)
    expect(successes).toHaveLength(1)

    closeDatabase(connectionB)
  })
})
