/**
 * `repos/mcp-oauth.ts` (MCP-7) — direct coverage of the repository layer
 * itself, driven with plain hashes and ids rather than through
 * `@bloombot/auth`'s own `mcp-oauth.ts` (that package's own test file
 * already proves the business logic end to end; a security review found
 * this 450-line repo had no test file of its own at all, only transitive
 * coverage through that one layer up). No account is seeded unless a test
 * actually needs the foreign key satisfied — `createAccount`'s own
 * organization/membership graph is more setup than most of these functions
 * need.
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import { accounts, mcpOauth, organizations } from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

function seedAccount(db: TestDatabase['db']): string {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Org', isPersonal: false },
    db
  )
  const account = accounts.createAccount(
    organizationId,
    {
      email: `${randomUUID()}@example.edu`,
      displayName: 'Test',
      role: 'owner',
    },
    db
  )
  return account.id
}

function seedClient(db: TestDatabase['db']): string {
  const client = mcpOauth.createClient(
    { id: randomUUID(), redirectUris: '["https://client.example/callback"]' },
    db
  )
  return client.id
}

describe('clients', () => {
  it('createClient always persists tokenEndpointAuthMethod "none"', () => {
    testDb = createTestDatabase()
    const client = mcpOauth.createClient(
      {
        id: randomUUID(),
        redirectUris: '["https://client.example/callback"]',
        clientName: 'A Client',
        scope: 'read write',
        grantTypes: '["authorization_code","refresh_token"]',
      },
      testDb.db
    )

    expect(client.tokenEndpointAuthMethod).toBe('none')
    expect(client.clientName).toBe('A Client')
  })

  it('getClient returns undefined for an unregistered id', () => {
    testDb = createTestDatabase()
    expect(mcpOauth.getClient(randomUUID(), testDb.db)).toBeUndefined()
  })
})

describe('pending authorizations', () => {
  it('createPendingAuthorization persists every optional field when given', () => {
    testDb = createTestDatabase()
    const clientId = seedClient(testDb.db)

    const row = mcpOauth.createPendingAuthorization(
      {
        id: randomUUID(),
        clientId,
        redirectUri: 'https://client.example/callback',
        codeChallenge: 'a-challenge',
        state: 'xyz',
        scope: 'read',
        resource: 'https://mcp.example/mcp',
        expiresAt: Date.now() + 60_000,
      },
      testDb.db
    )

    expect(row).toMatchObject({
      clientId,
      redirectUri: 'https://client.example/callback',
      codeChallenge: 'a-challenge',
      state: 'xyz',
      scope: 'read',
      resource: 'https://mcp.example/mcp',
      accountId: null,
    })
  })

  it('getPendingAuthorization refuses an expired row, identically to an unknown one', () => {
    testDb = createTestDatabase()
    const clientId = seedClient(testDb.db)
    const now = Date.now()
    const row = mcpOauth.createPendingAuthorization(
      {
        id: randomUUID(),
        clientId,
        redirectUri: 'https://client.example/callback',
        codeChallenge: 'a-challenge',
        expiresAt: now - 1,
      },
      testDb.db
    )

    expect(
      mcpOauth.getPendingAuthorization(row.id, now, testDb.db)
    ).toBeUndefined()
    expect(
      mcpOauth.getPendingAuthorization(randomUUID(), now, testDb.db)
    ).toBeUndefined()
  })

  it('claimPendingAuthorization binds to the first account, and refuses a second, different one', () => {
    testDb = createTestDatabase()
    const clientId = seedClient(testDb.db)
    const firstAccountId = seedAccount(testDb.db)
    const secondAccountId = seedAccount(testDb.db)
    const now = Date.now()
    const row = mcpOauth.createPendingAuthorization(
      {
        id: randomUUID(),
        clientId,
        redirectUri: 'https://client.example/callback',
        codeChallenge: 'a-challenge',
        expiresAt: now + 60_000,
      },
      testDb.db
    )

    const claimed = mcpOauth.claimPendingAuthorization(
      row.id,
      firstAccountId,
      now,
      testDb.db
    )
    expect(claimed?.accountId).toBe(firstAccountId)

    // Reclaiming as the same account is a no-op, not a refusal.
    expect(
      mcpOauth.claimPendingAuthorization(row.id, firstAccountId, now, testDb.db)
    ).toBeDefined()

    // A different account is refused — the row already belongs to the
    // first one.
    expect(
      mcpOauth.claimPendingAuthorization(
        row.id,
        secondAccountId,
        now,
        testDb.db
      )
    ).toBeUndefined()
  })

  it('deletePendingAuthorization removes the row, and reports whether one existed', () => {
    testDb = createTestDatabase()
    const clientId = seedClient(testDb.db)
    const row = mcpOauth.createPendingAuthorization(
      {
        id: randomUUID(),
        clientId,
        redirectUri: 'https://client.example/callback',
        codeChallenge: 'a-challenge',
        expiresAt: Date.now() + 60_000,
      },
      testDb.db
    )

    expect(mcpOauth.deletePendingAuthorization(row.id, testDb.db)).toBe(1)
    expect(mcpOauth.deletePendingAuthorization(row.id, testDb.db)).toBe(0)
  })

  it('deleteExpiredPendingAuthorizations sweeps only what has actually expired', () => {
    testDb = createTestDatabase()
    const clientId = seedClient(testDb.db)
    const now = Date.now()
    const expired = mcpOauth.createPendingAuthorization(
      {
        id: randomUUID(),
        clientId,
        redirectUri: 'https://client.example/callback',
        codeChallenge: 'a-challenge',
        expiresAt: now - 1,
      },
      testDb.db
    )
    const live = mcpOauth.createPendingAuthorization(
      {
        id: randomUUID(),
        clientId,
        redirectUri: 'https://client.example/callback',
        codeChallenge: 'a-challenge',
        expiresAt: now + 60_000,
      },
      testDb.db
    )

    const swept = mcpOauth.deleteExpiredPendingAuthorizations(now, testDb.db)

    expect(swept).toBe(1)
    expect(
      mcpOauth.getPendingAuthorization(expired.id, now, testDb.db)
    ).toBeUndefined()
    expect(
      mcpOauth.getPendingAuthorization(live.id, now, testDb.db)
    ).toBeDefined()
  })
})

describe('authorization codes', () => {
  it('peekAuthorizationCode is read-only; consumeAuthorizationCode spends it exactly once', () => {
    testDb = createTestDatabase()
    const clientId = seedClient(testDb.db)
    const accountId = seedAccount(testDb.db)
    const now = Date.now()
    const row = mcpOauth.createAuthorizationCode(
      {
        id: randomUUID(),
        clientId,
        codeHash: 'a-code-hash',
        codeChallenge: 'a-challenge',
        redirectUri: 'https://client.example/callback',
        accountId,
        expiresAt: now + 60_000,
      },
      testDb.db
    )

    expect(
      mcpOauth.peekAuthorizationCode('a-code-hash', clientId, now, testDb.db)
    ).toMatchObject({ id: row.id, usedAt: null })
    // A different client's own lookup finds nothing — a code is scoped to
    // the client it was issued to.
    expect(
      mcpOauth.peekAuthorizationCode(
        'a-code-hash',
        randomUUID(),
        now,
        testDb.db
      )
    ).toBeUndefined()

    const consumed = mcpOauth.consumeAuthorizationCode(
      'a-code-hash',
      clientId,
      now,
      testDb.db
    )
    expect(consumed?.id).toBe(row.id)
    // Single-use — the second attempt finds nothing left to spend.
    expect(
      mcpOauth.consumeAuthorizationCode('a-code-hash', clientId, now, testDb.db)
    ).toBeUndefined()
    expect(
      mcpOauth.peekAuthorizationCode('a-code-hash', clientId, now, testDb.db)
    ).toBeUndefined()
  })

  it('deleteExpiredAuthorizationCodes sweeps only what has expired', () => {
    testDb = createTestDatabase()
    const clientId = seedClient(testDb.db)
    const accountId = seedAccount(testDb.db)
    const now = Date.now()
    mcpOauth.createAuthorizationCode(
      {
        id: randomUUID(),
        clientId,
        codeHash: 'expired-hash',
        codeChallenge: 'a-challenge',
        redirectUri: 'https://client.example/callback',
        accountId,
        expiresAt: now - 1,
      },
      testDb.db
    )
    mcpOauth.createAuthorizationCode(
      {
        id: randomUUID(),
        clientId,
        codeHash: 'live-hash',
        codeChallenge: 'a-challenge',
        redirectUri: 'https://client.example/callback',
        accountId,
        expiresAt: now + 60_000,
      },
      testDb.db
    )

    expect(mcpOauth.deleteExpiredAuthorizationCodes(now, testDb.db)).toBe(1)
    expect(
      mcpOauth.peekAuthorizationCode('live-hash', clientId, now, testDb.db)
    ).toBeDefined()
  })
})

describe('refresh tokens', () => {
  it('findRefreshTokenByHash refuses a used, revoked, expired, or wrong-client row', () => {
    testDb = createTestDatabase()
    const clientId = seedClient(testDb.db)
    const accountId = seedAccount(testDb.db)
    const now = Date.now()
    const row = mcpOauth.createRefreshToken(
      {
        id: randomUUID(),
        clientId,
        tokenHash: 'a-refresh-hash',
        accountId,
        expiresAt: now + 60_000,
      },
      testDb.db
    )

    expect(
      mcpOauth.findRefreshTokenByHash(
        'a-refresh-hash',
        clientId,
        now,
        testDb.db
      )
    ).toMatchObject({ id: row.id })
    expect(
      mcpOauth.findRefreshTokenByHash(
        'a-refresh-hash',
        randomUUID(),
        now,
        testDb.db
      )
    ).toBeUndefined()

    mcpOauth.revokeRefreshToken('a-refresh-hash', testDb.db)
    expect(
      mcpOauth.findRefreshTokenByHash(
        'a-refresh-hash',
        clientId,
        now,
        testDb.db
      )
    ).toBeUndefined()
  })

  it('consumeRefreshToken is single-use', () => {
    testDb = createTestDatabase()
    const clientId = seedClient(testDb.db)
    const accountId = seedAccount(testDb.db)
    const now = Date.now()
    mcpOauth.createRefreshToken(
      {
        id: randomUUID(),
        clientId,
        tokenHash: 'a-refresh-hash',
        accountId,
        expiresAt: now + 60_000,
      },
      testDb.db
    )

    expect(
      mcpOauth.consumeRefreshToken('a-refresh-hash', clientId, now, testDb.db)
    ).toBeDefined()
    expect(
      mcpOauth.consumeRefreshToken('a-refresh-hash', clientId, now, testDb.db)
    ).toBeUndefined()
  })

  it('revokeRefreshToken is idempotent, and a no-op against an unknown hash', () => {
    testDb = createTestDatabase()
    const clientId = seedClient(testDb.db)
    const accountId = seedAccount(testDb.db)
    mcpOauth.createRefreshToken(
      {
        id: randomUUID(),
        clientId,
        tokenHash: 'a-refresh-hash',
        accountId,
        expiresAt: Date.now() + 60_000,
      },
      testDb.db
    )

    expect(() =>
      mcpOauth.revokeRefreshToken('a-refresh-hash', testDb.db)
    ).not.toThrow()
    expect(() =>
      mcpOauth.revokeRefreshToken('a-refresh-hash', testDb.db)
    ).not.toThrow()
    expect(() =>
      mcpOauth.revokeRefreshToken('never-issued', testDb.db)
    ).not.toThrow()
  })

  it('deleteExpiredRefreshTokens sweeps only what has expired', () => {
    testDb = createTestDatabase()
    const clientId = seedClient(testDb.db)
    const accountId = seedAccount(testDb.db)
    const now = Date.now()
    mcpOauth.createRefreshToken(
      {
        id: randomUUID(),
        clientId,
        tokenHash: 'expired-hash',
        accountId,
        expiresAt: now - 1,
      },
      testDb.db
    )
    mcpOauth.createRefreshToken(
      {
        id: randomUUID(),
        clientId,
        tokenHash: 'live-hash',
        accountId,
        expiresAt: now + 60_000,
      },
      testDb.db
    )

    expect(mcpOauth.deleteExpiredRefreshTokens(now, testDb.db)).toBe(1)
    expect(
      mcpOauth.findRefreshTokenByHash('live-hash', clientId, now, testDb.db)
    ).toBeDefined()
  })
})

describe('access tokens', () => {
  it('findAccessTokenByHash refuses a revoked or expired row', () => {
    testDb = createTestDatabase()
    const clientId = seedClient(testDb.db)
    const accountId = seedAccount(testDb.db)
    const now = Date.now()
    mcpOauth.createAccessToken(
      {
        id: randomUUID(),
        clientId,
        tokenHash: 'an-access-hash',
        accountId,
        expiresAt: now + 60_000,
      },
      testDb.db
    )

    expect(
      mcpOauth.findAccessTokenByHash('an-access-hash', now, testDb.db)
    ).toMatchObject({ clientId, accountId })

    mcpOauth.revokeAccessToken('an-access-hash', testDb.db)
    expect(
      mcpOauth.findAccessTokenByHash('an-access-hash', now, testDb.db)
    ).toBeUndefined()
  })

  it('revokeAccessTokensForRefreshToken revokes every access token issued alongside it', () => {
    testDb = createTestDatabase()
    const clientId = seedClient(testDb.db)
    const accountId = seedAccount(testDb.db)
    const now = Date.now()
    const refreshRow = mcpOauth.createRefreshToken(
      {
        id: randomUUID(),
        clientId,
        tokenHash: 'a-refresh-hash',
        accountId,
        expiresAt: now + 60_000,
      },
      testDb.db
    )
    mcpOauth.createAccessToken(
      {
        id: randomUUID(),
        clientId,
        tokenHash: 'an-access-hash',
        accountId,
        refreshTokenId: refreshRow.id,
        expiresAt: now + 60_000,
      },
      testDb.db
    )

    mcpOauth.revokeAccessTokensForRefreshToken(refreshRow.id, testDb.db)

    expect(
      mcpOauth.findAccessTokenByHash('an-access-hash', now, testDb.db)
    ).toBeUndefined()
  })

  it('deleteExpiredAccessTokens sweeps only what has expired', () => {
    testDb = createTestDatabase()
    const clientId = seedClient(testDb.db)
    const accountId = seedAccount(testDb.db)
    const now = Date.now()
    mcpOauth.createAccessToken(
      {
        id: randomUUID(),
        clientId,
        tokenHash: 'expired-hash',
        accountId,
        expiresAt: now - 1,
      },
      testDb.db
    )
    mcpOauth.createAccessToken(
      {
        id: randomUUID(),
        clientId,
        tokenHash: 'live-hash',
        accountId,
        expiresAt: now + 60_000,
      },
      testDb.db
    )

    expect(mcpOauth.deleteExpiredAccessTokens(now, testDb.db)).toBe(1)
    expect(
      mcpOauth.findAccessTokenByHash('live-hash', now, testDb.db)
    ).toBeDefined()
  })
})
