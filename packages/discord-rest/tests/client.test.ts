/**
 * `createDiscordRestClient` — the real implementation, tested against a
 * loopback fake standing in for Discord's `/oauth2/token` and
 * `/users/@me/guilds` endpoints. No test in this file reaches the network:
 * `apiBase`/`oauthBase` always point at `FakeDiscordServer#baseUrl`
 * (`127.0.0.1`), never at `CONFIG.DISCORD_API_BASE`/`DISCORD_OAUTH_BASE`'s
 * real defaults.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createDiscordRestClient,
  DiscordRequestError,
  type DiscordRestClient,
} from '../src/client.js'
import { FakeDiscordServer } from './helpers/fake-discord-server.js'

let server: FakeDiscordServer
let client: DiscordRestClient

beforeEach(async () => {
  server = await FakeDiscordServer.start()
  client = createDiscordRestClient({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    apiBase: server.baseUrl,
    oauthBase: server.baseUrl,
  })
})

afterEach(async () => {
  await server.stop()
})

describe('exchangeAuthorizationCode', () => {
  it('posts a form-encoded body with grant_type=authorization_code and the PKCE verifier', async () => {
    await client.exchangeAuthorizationCode({
      code: 'the-code',
      redirectUri: 'https://app.bloombot.test/discord/callback',
      codeVerifier: 'the-verifier',
    })

    expect(server.requests).toHaveLength(1)
    const request = server.requests[0]
    expect(request?.method).toBe('POST')
    expect(request?.path).toBe('/token')
    expect(request?.headers['content-type']).toBe(
      'application/x-www-form-urlencoded'
    )
    expect(request?.body).toEqual({
      grant_type: 'authorization_code',
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      code: 'the-code',
      redirect_uri: 'https://app.bloombot.test/discord/callback',
      code_verifier: 'the-verifier',
    })
  })

  it('parses a successful exchange into camelCase', async () => {
    server.respondToToken({
      status: 200,
      body: {
        access_token: 'a-user-token',
        token_type: 'Bearer',
        expires_in: 604800,
        scope: 'identify guilds bot',
      },
    })

    const token = await client.exchangeAuthorizationCode({
      code: 'the-code',
      redirectUri: 'https://app.bloombot.test/discord/callback',
      codeVerifier: 'the-verifier',
    })

    expect(token).toEqual({
      accessToken: 'a-user-token',
      tokenType: 'Bearer',
      expiresIn: 604800,
      scope: 'identify guilds bot',
    })
  })

  it('throws DiscordRequestError, carrying the status, for a non-2xx response', async () => {
    server.respondToToken({
      status: 400,
      body: { error: 'invalid_grant' },
    })

    await expect(
      client.exchangeAuthorizationCode({
        code: 'a-replayed-code',
        redirectUri: 'https://app.bloombot.test/discord/callback',
        codeVerifier: 'the-verifier',
      })
    ).rejects.toMatchObject(
      expect.objectContaining({ status: 400 }) as Partial<DiscordRequestError>
    )
  })
})

describe('getUserGuilds / getBotGuilds', () => {
  it("getUserGuilds sends the user's token as a Bearer header and returns the fake's user guild list", async () => {
    server.setUserGuilds([
      { id: '1', name: 'Guild One', owner: true, permissions: '0' },
    ])

    const guilds = await client.getUserGuilds('a-user-access-token')

    expect(guilds).toEqual([
      { id: '1', name: 'Guild One', owner: true, permissions: '0' },
    ])
    expect(server.requests[0]?.headers.authorization).toBe(
      'Bearer a-user-access-token'
    )
  })

  it("getBotGuilds sends the bot's token as a Bot header and returns the fake's bot guild list — a different list from the user's, proving the two are not confused", async () => {
    server.setUserGuilds([{ id: '1', name: 'User Guild' }])
    server.setBotGuilds([{ id: '2', name: 'Bot Guild' }])

    const guilds = await client.getBotGuilds('the-bot-token')

    expect(guilds).toEqual([{ id: '2', name: 'Bot Guild' }])
    expect(server.requests[0]?.headers.authorization).toBe('Bot the-bot-token')
  })

  it('throws DiscordRequestError for a non-2xx guild list response', async () => {
    server.respondToGuilds({
      status: 401,
      body: { message: '401: Unauthorized' },
    })

    await expect(
      client.getUserGuilds('an-expired-token')
    ).rejects.toMatchObject(
      expect.objectContaining({ status: 401 }) as Partial<DiscordRequestError>
    )
  })
})
