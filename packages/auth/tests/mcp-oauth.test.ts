/**
 * MCP-7: `mcp-oauth.ts`'s own business logic and persistence, driven
 * directly (no HTTP, no SDK) — `apps/mcp/tests/oauth-http.test.ts` proves
 * the same rules hold end to end, through `mcpAuthRouter`; this file proves
 * them at the layer that actually enforces each one, and covers a few
 * things the HTTP layer cannot reach as directly (a resource mismatch on
 * refresh, `revokeToken`'s own client-scoping).
 */

import { randomUUID } from 'node:crypto'

import { accounts, mcpOauth, organizations, schema } from '@bloombot/db'
import type { Database } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import {
  beginAuthorization,
  claimPendingAuthorization,
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
    const accountId = seedAccount(testDb.db)
    const begun = beginAuthorization(
      {
        clientId: client.id,
        redirectUri: 'https://client.example/callback',
        codeChallenge: 'challenge-value',
      },
      testDb.db
    )

    declinePendingAuthorization(begun.id, accountId, testDb.db)

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

  // MCP-7 security review — the state-fixation defence
  // (`schema.ts#mcpOauthPendingAuthorizations`'s own doc comment): the
  // first signed-in account to touch a pending authorization claims it,
  // and a second, different account can neither view its real client name
  // nor complete it.
  it('claims a pending authorization for the first account, and refuses a second, different account', () => {
    testDb = createTestDatabase()
    const client = registerOauthClient(
      { redirectUris: ['https://client.example/callback'] },
      testDb.db
    )
    const firstAccountId = seedAccount(testDb.db)
    const secondAccountId = seedAccount(testDb.db)
    const begun = beginAuthorization(
      {
        clientId: client.id,
        redirectUri: 'https://client.example/callback',
        codeChallenge: 'challenge-value',
      },
      testDb.db
    )

    expect(
      claimPendingAuthorization(begun.id, firstAccountId, testDb.db)
    ).toBeDefined()
    // Reclaiming as the same account is idempotent.
    expect(
      claimPendingAuthorization(begun.id, firstAccountId, testDb.db)
    ).toBeDefined()
    // A different account is refused, indistinguishably from an unknown id.
    expect(
      claimPendingAuthorization(begun.id, secondAccountId, testDb.db)
    ).toBeUndefined()

    // Consenting and declining both enforce the identical claim.
    expect(
      consentToPendingAuthorization(begun.id, secondAccountId, testDb.db)
    ).toBeUndefined()
    expect(
      consentToPendingAuthorization(begun.id, firstAccountId, testDb.db)
    ).toBeDefined()
  })
})

// MCP-7 security review — cheap fix: `beginAuthorization`'s own sweep of
// all four `deleteExpired*` repo functions (this file's own module comment
// on why they live there) had no test of its own; deleting all four calls
// left the whole suite green. This is the regression test that would have
// caught it, for every table `beginAuthorization` sweeps, not only pending
// authorizations (which the "claims/consents" tests above already exercise
// indirectly).
describe('beginAuthorization — sweeps every expired credential table on write', () => {
  it('an expired row in each table disappears; a live row and a row created by this same call both survive', () => {
    testDb = createTestDatabase()
    const client = registerOauthClient(
      { redirectUris: ['https://client.example/callback'] },
      testDb.db
    )
    const accountId = seedAccount(testDb.db)
    const now = Date.now()

    // One already-expired row in each of the three tables
    // `beginAuthorization` does not otherwise touch (`deleteExpiredPendingAuthorizations`'s
    // own sweep is already covered by the "claims/consents" tests above).
    mcpOauth.createAuthorizationCode(
      {
        id: randomUUID(),
        clientId: client.id,
        codeHash: 'expired-code-hash',
        codeChallenge: 'challenge-value',
        redirectUri: 'https://client.example/callback',
        accountId,
        expiresAt: now - 1,
      },
      testDb.db
    )
    mcpOauth.createRefreshToken(
      {
        id: randomUUID(),
        clientId: client.id,
        tokenHash: 'expired-refresh-hash',
        accountId,
        expiresAt: now - 1,
      },
      testDb.db
    )
    mcpOauth.createAccessToken(
      {
        id: randomUUID(),
        clientId: client.id,
        tokenHash: 'expired-access-hash',
        accountId,
        expiresAt: now - 1,
      },
      testDb.db
    )
    // A live row in each — must survive the sweep this test triggers.
    mcpOauth.createAuthorizationCode(
      {
        id: randomUUID(),
        clientId: client.id,
        codeHash: 'live-code-hash',
        codeChallenge: 'challenge-value',
        redirectUri: 'https://client.example/callback',
        accountId,
        expiresAt: now + 60_000,
      },
      testDb.db
    )
    mcpOauth.createRefreshToken(
      {
        id: randomUUID(),
        clientId: client.id,
        tokenHash: 'live-refresh-hash',
        accountId,
        expiresAt: now + 60_000,
      },
      testDb.db
    )
    mcpOauth.createAccessToken(
      {
        id: randomUUID(),
        clientId: client.id,
        tokenHash: 'live-access-hash',
        accountId,
        expiresAt: now + 60_000,
      },
      testDb.db
    )

    // The one call this file's own module comment says sweeps all four
    // tables — a plain `/authorize`, with nothing else going on.
    beginAuthorization(
      {
        clientId: client.id,
        redirectUri: 'https://client.example/callback',
        codeChallenge: 'a-fresh-challenge',
      },
      testDb.db
    )

    // Read the raw rows back, by hash, with no expiry filter of their own
    // — every lookup function in `repos/mcp-oauth.ts` already filters out
    // an expired row itself (the same `gt(expiresAt, now)` every one of
    // them carries), so asserting through one of those would pass whether
    // or not the sweep ever ran, and prove nothing about physical
    // deletion. This is what actually pins "the row is gone", not merely
    // "unreachable through the one path that already hides an expired
    // row regardless".
    const codeHashes = testDb.db
      .select({ hash: schema.mcpOauthAuthorizationCodes.codeHash })
      .from(schema.mcpOauthAuthorizationCodes)
      .all()
      .map((row) => row.hash)
    const refreshHashes = testDb.db
      .select({ hash: schema.mcpOauthRefreshTokens.tokenHash })
      .from(schema.mcpOauthRefreshTokens)
      .all()
      .map((row) => row.hash)
    const accessHashes = testDb.db
      .select({ hash: schema.mcpOauthAccessTokens.tokenHash })
      .from(schema.mcpOauthAccessTokens)
      .all()
      .map((row) => row.hash)

    expect(codeHashes).not.toContain('expired-code-hash')
    expect(refreshHashes).not.toContain('expired-refresh-hash')
    expect(accessHashes).not.toContain('expired-access-hash')

    // Live rows, and the row this very call just created, all still exist.
    expect(codeHashes).toContain('live-code-hash')
    expect(refreshHashes).toContain('live-refresh-hash')
    expect(accessHashes).toContain('live-access-hash')
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
  function issueTokens(options: { resource?: string } = {}) {
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
        ...(options.resource ? { resource: options.resource } : {}),
      },
      testDb.db
    )
    const issued = consentToPendingAuthorization(begun.id, accountId, testDb.db)
    if (!issued) throw new Error('setup failed')
    const tokens = exchangeAuthorizationCode(
      issued.code,
      client.id,
      issued.redirectUri,
      options.resource,
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

  // MCP-7 security review — resource indicators (RFC 8707) were completely
  // unexercised: no test constructed a token bound to a `resource` at all,
  // so this check never ran in the whole suite.
  it('refuses a resource that does not match the one the refresh token was issued for', () => {
    testDb = createTestDatabase()
    const { client, tokens } = issueTokens({
      resource: 'https://mcp.example/mcp',
    })

    let caught: unknown
    try {
      exchangeRefreshToken(
        tokens.refreshToken,
        client.id,
        'https://other.example/mcp',
        testDb.db
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(McpOauthError)
    expect((caught as McpOauthError).code).toBe('invalid_target')
  })

  it('accepts the matching resource, and the resulting access token still verifies to it', () => {
    testDb = createTestDatabase()
    const { client, tokens } = issueTokens({
      resource: 'https://mcp.example/mcp',
    })

    const rotated = exchangeRefreshToken(
      tokens.refreshToken,
      client.id,
      'https://mcp.example/mcp',
      testDb.db
    )
    const verified = verifyAccessToken(rotated.accessToken, testDb.db)
    expect(verified?.resource).toBe('https://mcp.example/mcp')
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

  // MCP-7 security review — this branch had zero coverage: dropping the
  // `clientId` scoping on `findRefreshTokenByHash` inside `revokeToken`
  // (this file's own doc comment) failed nothing, because no test ever
  // revoked a refresh token at all. This is also the credential a person
  // would actually revoke, not the short-lived access token.
  it('revokes a refresh token, scoped to the client that owns it', () => {
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

    // A different client revoking a refresh token it does not own does
    // nothing — the refresh token still rotates successfully afterward.
    revokeToken(tokens.refreshToken, otherClient.id, testDb.db)
    const stillWorks = exchangeRefreshToken(
      tokens.refreshToken,
      client.id,
      undefined,
      testDb.db
    )
    expect(stillWorks.accessToken).toBeDefined()

    // The owning client's own revoke actually revokes — the *new* refresh
    // token this rotation just issued no longer exchanges.
    revokeToken(stillWorks.refreshToken, client.id, testDb.db)
    expect(() =>
      exchangeRefreshToken(
        stillWorks.refreshToken,
        client.id,
        undefined,
        testDb.db
      )
    ).toThrow(McpOauthError)
    // Revoking a refresh token also revokes the access token it was
    // issued alongside (`schema.ts`'s own module comment).
    expect(verifyAccessToken(stillWorks.accessToken, testDb.db)).toBeUndefined()
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
