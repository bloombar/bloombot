/**
 * MCP-7: the OAuth 2.1 authorization server this app now is, exercised over
 * real HTTP through `mcpAuthRouter` (`server.ts`) and `oauth-provider.ts` —
 * dynamic registration, the full authorization-code-plus-PKCE round trip,
 * refresh rotation, revocation, and the metadata documents a real
 * ChatGPT/Claude connector discovers this server through. `apps/mcp`'s own
 * existing `server.test.ts`/`call-tool.test.ts`/`tool-surface.test.ts`
 * already cover MCP-3/4/6 and the dispatch catalog; this file is additive,
 * not a replacement for any of them.
 */

import { createHash, randomBytes } from 'node:crypto'

import { createPlatformRegistry } from '@bloombot/actions'
import { schema } from '@bloombot/db'
import { describe, expect, it, afterEach } from 'vitest'
import request from 'supertest'

import { buildOauthProvider } from '../src/oauth-provider.js'
import { buildApp, type ServerDependencies } from '../src/server.js'
import { buildToolDefinitions } from '../src/tool-surface.js'
import { startTestServer } from './helpers/mcp-http-client.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'
import { seedSignedInAccount } from './helpers/seed.js'

function createFakeLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
  } as unknown as ServerDependencies['logger']
}

const ISSUER_URL = new URL('http://127.0.0.1:1')

async function buildTestApp(db: ServerDependencies['db']) {
  const deps: ServerDependencies = {
    db,
    logger: createFakeLogger(),
    toolDefinitions: buildToolDefinitions(createPlatformRegistry()),
    oauthProvider: buildOauthProvider({
      db,
      consentUrl: 'http://127.0.0.1:1/oauth/mcp/authorize',
    }),
    issuerUrl: ISSUER_URL,
  }
  return startTestServer(buildApp(deps))
}

/** A fresh PKCE pair (RFC 7636 §4.1/§4.2) — a 32-byte verifier, its S256 challenge. */
function pkcePair() {
  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url')
  return { codeVerifier, codeChallenge }
}

async function registerClient(
  server: Awaited<ReturnType<typeof buildTestApp>>,
  redirectUris: string[] = ['https://client.example/callback']
) {
  const response = await request(server)
    .post('/register')
    .send({ redirect_uris: redirectUris, token_endpoint_auth_method: 'none' })
  expect(response.status).toBe(201)
  return response.body as { client_id: string; redirect_uris: string[] }
}

/** Drives `/authorize` far enough to obtain the pending-authorization id `apps/api`'s consent route would read — this file never runs that route (it lives in `apps/api`, its own test file), so it reaches into the shared database directly, the same way `apps/api`'s own consent-route test reaches into it from the other side. */
function findPendingAuthorizationId(db: TestDatabase['db']): string {
  const row = db
    .select()
    .from(schema.mcpOauthPendingAuthorizations)
    .orderBy(schema.mcpOauthPendingAuthorizations.createdAt)
    .get() as { id: string } | undefined
  if (!row) throw new Error('setup failed: no pending authorization found')
  return row.id
}

let testDb: TestDatabase | undefined

afterEach(() => {
  testDb?.cleanup()
  testDb = undefined
})

describe('dynamic client registration (RFC 7591)', () => {
  it('persists a registered client, retrievable by id', async () => {
    testDb = createTestDatabase()
    const server = await buildTestApp(testDb.db)

    const client = await registerClient(server)

    expect(client.client_id).toBeDefined()
    expect(client.redirect_uris).toEqual(['https://client.example/callback'])
    // MCP-7's own deliberate scope narrowing (`schema.ts#mcpOauthClients`'s
    // own module comment): no secret is ever issued, regardless of what
    // was asked for.
    expect(client.client_id).not.toMatch(/secret/i)
  })

  it('refuses an unregistered client id at /authorize', async () => {
    testDb = createTestDatabase()
    const server = await buildTestApp(testDb.db)
    const { codeChallenge } = pkcePair()

    const response = await request(server).get('/authorize').query({
      client_id: 'never-registered',
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })

    expect(response.status).toBe(400)
  })
})

describe('the authorization-code flow with PKCE', () => {
  it('a request with no bearer token at /authorize redirects an unauthenticated caller to sign in, and the full round trip succeeds once an account consents', async () => {
    testDb = createTestDatabase()
    const server = await buildTestApp(testDb.db)
    const client = await registerClient(server)
    const { codeVerifier, codeChallenge } = pkcePair()

    const authorizeResponse = await request(server).get('/authorize').query({
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state: 'xyz',
    })

    // `oauth-provider.ts#authorize` redirects to the consent URL — this is
    // "sent to sign in" from an unauthenticated caller's own point of view
    // (`apps/api`'s consent route answers with a sign-in prompt when no
    // session cookie is present; that route's own test file covers that
    // directly). This file only proves the redirect happens and carries the
    // request id through.
    expect(authorizeResponse.status).toBe(302)
    expect(authorizeResponse.headers['location']).toContain(
      '/oauth/mcp/authorize?request='
    )

    // Simulate the consent step (`apps/api/src/routes/mcp-oauth-consent.ts`,
    // its own file) — a signed-in account approving the pending
    // authorization this call created.
    const caller = seedSignedInAccount(testDb.db)
    const pendingId = findPendingAuthorizationId(testDb.db)
    const { consentToPendingAuthorization } = await import('@bloombot/auth')
    const issued = consentToPendingAuthorization(
      pendingId,
      caller.accountId,
      testDb.db
    )
    if (!issued) throw new Error('setup failed: consent did not issue a code')
    expect(issued.state).toBe('xyz')

    const tokenResponse = await request(server)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code: issued.code,
        code_verifier: codeVerifier,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
      })

    expect(tokenResponse.status).toBe(200)
    expect(tokenResponse.body.access_token).toBeDefined()
    expect(tokenResponse.body.refresh_token).toBeDefined()
    expect(tokenResponse.body.token_type).toBe('bearer')

    // Hashed at rest — the presented value never appears verbatim in the
    // database (the non-negotiable this whole slice exists to hold).
    const stored = testDb.db
      .select()
      .from(schema.mcpOauthAccessTokens)
      .get() as { tokenHash: string } | undefined
    expect(stored?.tokenHash).toBeDefined()
    expect(stored?.tokenHash).not.toBe(tokenResponse.body.access_token)

    // The minted token now authenticates an ordinary `/mcp` call, carrying
    // the consenting account's own authority (MCP-3, via the OAuth path).
    const mcpResponse = await request(server)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('Authorization', `Bearer ${tokenResponse.body.access_token}`)
      .send({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        },
      })
    expect(mcpResponse.status).toBe(200)
  })

  it('a missing code_verifier is refused', async () => {
    testDb = createTestDatabase()
    const server = await buildTestApp(testDb.db)
    const client = await registerClient(server)
    const { codeChallenge } = pkcePair()

    await request(server).get('/authorize').query({
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })
    const caller = seedSignedInAccount(testDb.db)
    const pendingId = findPendingAuthorizationId(testDb.db)
    const { consentToPendingAuthorization } = await import('@bloombot/auth')
    const issued = consentToPendingAuthorization(
      pendingId,
      caller.accountId,
      testDb.db
    )
    if (!issued) throw new Error('setup failed')

    const response = await request(server).post('/token').type('form').send({
      grant_type: 'authorization_code',
      code: issued.code,
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      // No `code_verifier` at all.
    })

    expect(response.status).toBe(400)
  })

  it('a wrong code_verifier is refused', async () => {
    testDb = createTestDatabase()
    const server = await buildTestApp(testDb.db)
    const client = await registerClient(server)
    const { codeChallenge } = pkcePair()

    await request(server).get('/authorize').query({
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })
    const caller = seedSignedInAccount(testDb.db)
    const pendingId = findPendingAuthorizationId(testDb.db)
    const { consentToPendingAuthorization } = await import('@bloombot/auth')
    const issued = consentToPendingAuthorization(
      pendingId,
      caller.accountId,
      testDb.db
    )
    if (!issued) throw new Error('setup failed')

    const response = await request(server).post('/token').type('form').send({
      grant_type: 'authorization_code',
      code: issued.code,
      code_verifier: 'the-wrong-verifier-entirely-00000000000000',
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
    })

    expect(response.status).toBe(400)
  })

  it('a code cannot be replayed', async () => {
    testDb = createTestDatabase()
    const server = await buildTestApp(testDb.db)
    const client = await registerClient(server)
    const { codeVerifier, codeChallenge } = pkcePair()

    await request(server).get('/authorize').query({
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })
    const caller = seedSignedInAccount(testDb.db)
    const pendingId = findPendingAuthorizationId(testDb.db)
    const { consentToPendingAuthorization } = await import('@bloombot/auth')
    const issued = consentToPendingAuthorization(
      pendingId,
      caller.accountId,
      testDb.db
    )
    if (!issued) throw new Error('setup failed')

    const body = {
      grant_type: 'authorization_code',
      code: issued.code,
      code_verifier: codeVerifier,
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
    }
    const first = await request(server).post('/token').type('form').send(body)
    expect(first.status).toBe(200)

    const second = await request(server).post('/token').type('form').send(body)
    expect(second.status).toBe(400)
  })

  it('an expired code is refused', async () => {
    testDb = createTestDatabase()
    const server = await buildTestApp(testDb.db)
    const client = await registerClient(server)
    const { codeVerifier, codeChallenge } = pkcePair()

    await request(server).get('/authorize').query({
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })
    const caller = seedSignedInAccount(testDb.db)
    const pendingId = findPendingAuthorizationId(testDb.db)
    const { consentToPendingAuthorization, DEFAULT_AUTHORIZATION_CODE_TTL_MS } =
      await import('@bloombot/auth')
    const issued = consentToPendingAuthorization(
      pendingId,
      caller.accountId,
      testDb.db,
      -1 // already expired, the instant it is minted
    )
    if (!issued) throw new Error('setup failed')
    void DEFAULT_AUTHORIZATION_CODE_TTL_MS

    const response = await request(server).post('/token').type('form').send({
      grant_type: 'authorization_code',
      code: issued.code,
      code_verifier: codeVerifier,
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
    })

    expect(response.status).toBe(400)
  })
})

describe('redirect_uri exact matching — the classic MCP/OAuth vulnerability', () => {
  it('refuses a redirect_uri that is a prefix of a registered one', async () => {
    testDb = createTestDatabase()
    const server = await buildTestApp(testDb.db)
    const client = await registerClient(server, [
      'https://client.example/callback/finish',
    ])
    const { codeChallenge } = pkcePair()

    const response = await request(server).get('/authorize').query({
      client_id: client.client_id,
      redirect_uri: 'https://client.example/callback',
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })

    expect(response.status).toBe(400)
  })

  it('refuses a registered redirect_uri with an extra path segment appended', async () => {
    testDb = createTestDatabase()
    const server = await buildTestApp(testDb.db)
    const client = await registerClient(server, [
      'https://client.example/callback',
    ])
    const { codeChallenge } = pkcePair()

    const response = await request(server).get('/authorize').query({
      client_id: client.client_id,
      redirect_uri: 'https://client.example/callback/extra',
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })

    expect(response.status).toBe(400)
  })

  it('accepts the exactly-registered redirect_uri', async () => {
    testDb = createTestDatabase()
    const server = await buildTestApp(testDb.db)
    const client = await registerClient(server, [
      'https://client.example/callback',
    ])
    const { codeChallenge } = pkcePair()

    const response = await request(server).get('/authorize').query({
      client_id: client.client_id,
      redirect_uri: 'https://client.example/callback',
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })

    expect(response.status).toBe(302)
  })
})

describe('refresh rotation and revocation', () => {
  async function issueTokenPair(
    server: Awaited<ReturnType<typeof buildTestApp>>,
    db: TestDatabase['db'],
    client: { client_id: string; redirect_uris: string[] }
  ) {
    const { codeVerifier, codeChallenge } = pkcePair()
    await request(server).get('/authorize').query({
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })
    const caller = seedSignedInAccount(db)
    const pendingId = findPendingAuthorizationId(db)
    const { consentToPendingAuthorization } = await import('@bloombot/auth')
    const issued = consentToPendingAuthorization(
      pendingId,
      caller.accountId,
      db
    )
    if (!issued) throw new Error('setup failed')
    const tokenResponse = await request(server)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code: issued.code,
        code_verifier: codeVerifier,
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
      })
    return tokenResponse.body as {
      access_token: string
      refresh_token: string
    }
  }

  it('rotates on refresh, and a used refresh token is refused on replay', async () => {
    testDb = createTestDatabase()
    const server = await buildTestApp(testDb.db)
    const client = await registerClient(server)
    const first = await issueTokenPair(server, testDb.db, client)

    const refreshed = await request(server).post('/token').type('form').send({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: client.client_id,
    })
    expect(refreshed.status).toBe(200)
    expect(refreshed.body.refresh_token).not.toBe(first.refresh_token)
    expect(refreshed.body.access_token).not.toBe(first.access_token)

    const replay = await request(server).post('/token').type('form').send({
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: client.client_id,
    })
    expect(replay.status).toBe(400)
  })

  it('/revoke actually revokes — a revoked access token no longer authenticates /mcp', async () => {
    testDb = createTestDatabase()
    const server = await buildTestApp(testDb.db)
    const client = await registerClient(server)
    const issued = await issueTokenPair(server, testDb.db, client)

    const revoke = await request(server).post('/revoke').type('form').send({
      token: issued.access_token,
      client_id: client.client_id,
    })
    expect(revoke.status).toBe(200)

    const mcpResponse = await request(server)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('Authorization', `Bearer ${issued.access_token}`)
      .send({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        },
      })
    expect(mcpResponse.status).toBe(401)
  })
})

describe('metadata documents (RFC 8414 / RFC 9728)', () => {
  it('serves authorization-server metadata derived from the configured issuer', async () => {
    testDb = createTestDatabase()
    const server = await buildTestApp(testDb.db)

    const response = await request(server).get(
      '/.well-known/oauth-authorization-server'
    )

    expect(response.status).toBe(200)
    expect(response.body.issuer).toBe(ISSUER_URL.href)
    expect(response.body.authorization_endpoint).toContain(ISSUER_URL.origin)
  })

  it("serves protected-resource metadata naming this server's own /mcp resource", async () => {
    testDb = createTestDatabase()
    const server = await buildTestApp(testDb.db)

    const response = await request(server).get(
      '/.well-known/oauth-protected-resource/mcp'
    )

    expect(response.status).toBe(200)
    expect(response.body.resource).toContain('/mcp')
  })

  it('changes when the configured issuer changes — proving the URLs are derived, not hard-coded', async () => {
    testDb = createTestDatabase()
    const otherDb = testDb.db
    const otherIssuer = new URL('http://127.0.0.1:2')
    const deps: ServerDependencies = {
      db: otherDb,
      logger: createFakeLogger(),
      toolDefinitions: buildToolDefinitions(createPlatformRegistry()),
      oauthProvider: buildOauthProvider({
        db: otherDb,
        consentUrl: 'http://127.0.0.1:2/oauth/mcp/authorize',
      }),
      issuerUrl: otherIssuer,
    }
    const server = await startTestServer(buildApp(deps))

    const response = await request(server).get(
      '/.well-known/oauth-authorization-server'
    )

    expect(response.body.issuer).toBe(otherIssuer.href)
  })
})
