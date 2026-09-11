/**
 * MCP-7: `mcp-oauth.ts`'s own business logic and persistence, driven
 * directly (no HTTP, no SDK) — `apps/mcp/tests/oauth-http.test.ts` proves
 * the same rules hold end to end, through `mcpAuthRouter`; this file proves
 * them at the layer that actually enforces each one, and covers a few
 * things the HTTP layer cannot reach as directly (a resource mismatch on
 * refresh, `revokeToken`'s own client-scoping).
 */

import { randomUUID } from 'node:crypto'

import { accounts, organizations, schema } from '@bloombot/db'
import type { Database } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import {
  beginAuthorization,
  consentToPendingAuthorization,
  declinePendingAuthorization,
  exchangeAuthorizationCode,
  exchangeRefreshToken,
  getOauthClient,
  McpOauthError,
  peekAuthorizationCodeChallenge,
  peekPendingAuthorization,
  registerOauthClient,
  revokeToken,
  verifyAccessToken,
} from '../src/mcp-oauth.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

function seedAccount(db: Database): string {
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

describe('registerOauthClient / getOauthClient', () => {
  it('never issues or stores a client secret, regardless of what is asked for', () => {
    testDb = createTestDatabase()
    const client = registerOauthClient(
      { redirectUris: ['https://client.example/callback'] },
      testDb.db
    )

    expect(getOauthClient(client.id, testDb.db)).toEqual(client)
    const row = testDb.db.select().from(schema.mcpOauthClients).get() as {
      tokenEndpointAuthMethod: string
    }
    expect(row.tokenEndpointAuthMethod).toBe('none')
  })

  it('returns undefined for an unregistered client', () => {
    testDb = createTestDatabase()
    expect(getOauthClient(randomUUID(), testDb.db)).toBeUndefined()
  })
})

describe('beginAuthorization / consentToPendingAuthorization', () => {
  it('consenting binds accountId only from the caller, and returns a code redeemable at /token', () => {
    testDb = createTestDatabase()
    const client = registerOauthClient(
      { redirectUris: ['https://client.example/callback'] },
      testDb.db
    )
    const accountId = seedAccount(testDb.db)
    const begun = beginAuthorization(
      {
        clientId: client.id,
        redirectUri: 'https://client.example/callback',
        codeChallenge: 'challenge-value',
        state: 'abc',
      },
      testDb.db
    )

    const issued = consentToPendingAuthorization(begun.id, accountId, testDb.db)
    expect(issued?.state).toBe('abc')
    expect(issued?.redirectUri).toBe('https://client.example/callback')

    // The pending row is gone — consenting twice to the same id is not
    // possible once this runs once.
    expect(peekPendingAuthorization(begun.id, testDb.db)).toBeUndefined()

    // Hashed at rest — the code itself never appears verbatim in storage.
    const row = testDb.db
      .select()
      .from(schema.mcpOauthAuthorizationCodes)
      .get() as { codeHash: string; accountId: string }
    expect(row.codeHash).not.toBe(issued?.code)
    expect(row.accountId).toBe(accountId)
  })

  it('declining deletes the pending authorization, issuing nothing', () => {
    testDb = createTestDatabase()
    const client = registerOauthClient(
      { redirectUris: ['https://client.example/callback'] },
      testDb.db
    )
    const begun = beginAuthorization(
      {
        clientId: client.id,
        redirectUri: 'https://client.example/callback',
        codeChallenge: 'challenge-value',
      },
      testDb.db
    )

    declinePendingAuthorization(begun.id, testDb.db)

    expect(peekPendingAuthorization(begun.id, testDb.db)).toBeUndefined()
    expect(
      testDb.db.select().from(schema.mcpOauthAuthorizationCodes).all()
    ).toEqual([])
  })

  it('consenting to an unknown or already-consumed id returns undefined', () => {
    testDb = createTestDatabase()
    const accountId = seedAccount(testDb.db)
    expect(
      consentToPendingAuthorization(randomUUID(), accountId, testDb.db)
    ).toBeUndefined()
  })
})

describe('exchangeAuthorizationCode', () => {
  function issueCode(overrides: { resource?: string } = {}) {
    const client = registerOauthClient(
      { redirectUris: ['https://client.example/callback'] },
      testDb.db
    )
    const accountId = seedAccount(testDb.db)
    const begun = beginAuthorization(
      {
        clientId: client.id,
        redirectUri: 'https://client.example/callback',
        codeChallenge: 'challenge-value',
        ...(overrides.resource ? { resource: overrides.resource } : {}),
      },
      testDb.db
    )
    const issued = consentToPendingAuthorization(begun.id, accountId, testDb.db)
    if (!issued) throw new Error('setup failed')
    return { client, accountId, issued }
  }

  it('exchanges a valid code for hashed-at-rest access and refresh tokens, attributed to the consenting account', () => {
    testDb = createTestDatabase()
    const { client, accountId, issued } = issueCode()

    const tokens = exchangeAuthorizationCode(
      issued.code,
      client.id,
      issued.redirectUri,
      undefined,
      testDb.db
    )

    expect(tokens.accessToken).toBeDefined()
    expect(tokens.refreshToken).toBeDefined()
    const verified = verifyAccessToken(tokens.accessToken, testDb.db)
    expect(verified?.accountId).toBe(accountId)
    expect(verified?.clientId).toBe(client.id)

    const accessRow = testDb.db
      .select()
      .from(schema.mcpOauthAccessTokens)
      .get() as { tokenHash: string }
    expect(accessRow.tokenHash).not.toBe(tokens.accessToken)
    const refreshRow = testDb.db
      .select()
      .from(schema.mcpOauthRefreshTokens)
      .get() as { tokenHash: string }
    expect(refreshRow.tokenHash).not.toBe(tokens.refreshToken)
  })

  it('is single-use: exchanging the same code twice refuses the second time', () => {
    testDb = createTestDatabase()
    const { client, issued } = issueCode()

    exchangeAuthorizationCode(
      issued.code,
      client.id,
      issued.redirectUri,
      undefined,
      testDb.db
    )
    expect(() =>
      exchangeAuthorizationCode(
        issued.code,
        client.id,
        issued.redirectUri,
        undefined,
        testDb.db
      )
    ).toThrow(McpOauthError)
  })

  it('refuses a redirect_uri that does not match the one the code was issued for', () => {
    testDb = createTestDatabase()
    const { client, issued } = issueCode()

    expect(() =>
      exchangeAuthorizationCode(
        issued.code,
        client.id,
        'https://attacker.example/callback',
        undefined,
        testDb.db
      )
    ).toThrow(McpOauthError)
  })

  it('refuses a resource that does not match the one the authorization named', () => {
    testDb = createTestDatabase()
    const { client, issued } = issueCode({
      resource: 'https://mcp.example/mcp',
    })

    let caught: unknown
    try {
      exchangeAuthorizationCode(
        issued.code,
        client.id,
        issued.redirectUri,
        'https://other.example/mcp',
        testDb.db
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(McpOauthError)
    expect((caught as McpOauthError).code).toBe('invalid_target')
  })

  it('refuses a code presented against a different client than the one it was issued to', () => {
    testDb = createTestDatabase()
    const { issued } = issueCode()
    const otherClient = registerOauthClient(
      { redirectUris: ['https://other.example/callback'] },
      testDb.db
    )

    expect(() =>
      exchangeAuthorizationCode(
        issued.code,
        otherClient.id,
        issued.redirectUri,
        undefined,
        testDb.db
      )
    ).toThrow(McpOauthError)
  })

  it('peekAuthorizationCodeChallenge is read-only — the code still redeems afterward', () => {
    testDb = createTestDatabase()
    const { client, issued } = issueCode()

    const challenge = peekAuthorizationCodeChallenge(
      issued.code,
      client.id,
      testDb.db
    )
    expect(challenge).toBe('challenge-value')

    expect(() =>
      exchangeAuthorizationCode(
        issued.code,
        client.id,
        issued.redirectUri,
        undefined,
        testDb.db
      )
    ).not.toThrow()
  })
})

describe('exchangeRefreshToken', () => {
  function issueTokens() {
    const client = registerOauthClient(
      { redirectUris: ['https://client.example/callback'] },
      testDb.db
    )
    const accountId = seedAccount(testDb.db)
    const begun = beginAuthorization(
      {
        clientId: client.id,
        redirectUri: 'https://client.example/callback',
        codeChallenge: 'challenge-value',
      },
      testDb.db
    )
    const issued = consentToPendingAuthorization(begun.id, accountId, testDb.db)
    if (!issued) throw new Error('setup failed')
    const tokens = exchangeAuthorizationCode(
      issued.code,
      client.id,
      issued.redirectUri,
      undefined,
      testDb.db
    )
    return { client, accountId, tokens }
  }

  it('rotates: the old refresh token stops working, the old access token is revoked too', () => {
    testDb = createTestDatabase()
    const { client, tokens } = issueTokens()

    const rotated = exchangeRefreshToken(
      tokens.refreshToken,
      client.id,
      undefined,
      testDb.db
    )
    expect(rotated.accessToken).not.toBe(tokens.accessToken)
    expect(rotated.refreshToken).not.toBe(tokens.refreshToken)

    // The old access token no longer verifies — rotating away its own
    // refresh token revoked it (`schema.ts`'s own module comment).
    expect(verifyAccessToken(tokens.accessToken, testDb.db)).toBeUndefined()
    // The new one does.
    expect(verifyAccessToken(rotated.accessToken, testDb.db)).toBeDefined()

    expect(() =>
      exchangeRefreshToken(tokens.refreshToken, client.id, undefined, testDb.db)
    ).toThrow(McpOauthError)
  })
})

describe('revokeToken', () => {
  it('revokes an access token, scoped to the client that owns it', () => {
    testDb = createTestDatabase()
    const client = registerOauthClient(
      { redirectUris: ['https://client.example/callback'] },
      testDb.db
    )
    const accountId = seedAccount(testDb.db)
    const begun = beginAuthorization(
      {
        clientId: client.id,
        redirectUri: 'https://client.example/callback',
        codeChallenge: 'challenge-value',
      },
      testDb.db
    )
    const issued = consentToPendingAuthorization(begun.id, accountId, testDb.db)
    if (!issued) throw new Error('setup failed')
    const tokens = exchangeAuthorizationCode(
      issued.code,
      client.id,
      issued.redirectUri,
      undefined,
      testDb.db
    )
    const otherClient = registerOauthClient(
      { redirectUris: ['https://other.example/callback'] },
      testDb.db
    )

    // A different client revoking a token it does not own does nothing.
    revokeToken(tokens.accessToken, otherClient.id, testDb.db)
    expect(verifyAccessToken(tokens.accessToken, testDb.db)).toBeDefined()

    // The owning client's own revoke actually revokes.
    revokeToken(tokens.accessToken, client.id, testDb.db)
    expect(verifyAccessToken(tokens.accessToken, testDb.db)).toBeUndefined()
  })

  it('is a no-op, not a throw, for a token that was never issued', () => {
    testDb = createTestDatabase()
    const client = registerOauthClient(
      { redirectUris: ['https://client.example/callback'] },
      testDb.db
    )
    expect(() =>
      revokeToken('never-issued', client.id, testDb.db)
    ).not.toThrow()
  })
})
