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

  // Finding 3 of the TEN-4..6 rework: a single page (Discord's own 200-entry
  // maximum) is not the whole story once a caller or the bot belongs to
  // more guilds than that — `getGuilds` must keep paging with `after` until
  // a short page tells it to stop, not read page one and call it done.
  it('walks every page when the guild list is larger than one page', async () => {
    const fullList = Array.from({ length: 250 }, (_, i) => ({
      id: String(i + 1).padStart(3, '0'),
      name: `Guild ${i + 1}`,
      owner: false,
      permissions: '0',
    }))
    server.setUserGuilds(fullList)

    const guilds = await client.getUserGuilds('a-user-access-token')

    expect(guilds).toHaveLength(250)
    expect(guilds.map((g) => g.id)).toEqual(fullList.map((g) => g.id))
    // Two requests: a full 200-entry page, then a short 50-entry one that
    // told the client to stop — the second one's `after` is the first
    // page's own last id, proving the cursor was actually threaded through
    // rather than the same first page being re-read.
    const guildRequests = server.requests.filter((r) =>
      r.path.startsWith('/users/@me/guilds')
    )
    expect(guildRequests).toHaveLength(2)
    expect(guildRequests[0]?.path).not.toContain('after=')
    expect(guildRequests[1]?.path).toContain(`after=${fullList[199]?.id}`)
  })

  // A page that comes back exactly `GUILD_LIST_PAGE_LIMIT` long ends the
  // walk in one request when there is nothing further — a single page well
  // under the limit must not trigger a second, empty round trip.
  it('makes exactly one request when the guild list fits in a single page', async () => {
    server.setUserGuilds([
      { id: '1', name: 'Guild One', owner: true, permissions: '0' },
    ])

    const guilds = await client.getUserGuilds('a-user-access-token')

    expect(guilds).toHaveLength(1)
    expect(
      server.requests.filter((r) => r.path.startsWith('/users/@me/guilds'))
    ).toHaveLength(1)
  })
})

describe('DiscordRequestError (finding 5 of the TEN-4..6 rework)', () => {
  it("carries body for a caller that reads it directly, but keeps it out of JSON.stringify — the shape a log serializer that walks own enumerable properties (pino's default err serializer) sees", async () => {
    server.respondToToken({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'the-auth-code' },
    })

    let caught: DiscordRequestError | undefined
    try {
      await client.exchangeAuthorizationCode({
        code: 'the-auth-code',
        redirectUri: 'https://app.bloombot.test/discord/callback',
        codeVerifier: 'the-verifier',
      })
    } catch (error) {
      caught = error as DiscordRequestError
    }

    expect(caught).toBeInstanceOf(DiscordRequestError)
    expect(caught?.body).toEqual({
      error: 'invalid_grant',
      error_description: 'the-auth-code',
    })
    // The property a naive log call (`JSON.stringify`, or pino's default
    // `err` serializer, which copies an error's own enumerable properties)
    // would see nothing of `body` in.
    expect(JSON.stringify(caught)).not.toContain('the-auth-code')
    expect(Object.keys(caught as object)).not.toContain('body')
  })
})

describe('a 2xx response with no usable body (cheap-fix 6 of the TEN-4..6 rework)', () => {
  it('exchangeAuthorizationCode throws when the token endpoint answers 2xx with no access_token', async () => {
    server.respondToToken({ status: 200, body: { token_type: 'Bearer' } })

    await expect(
      client.exchangeAuthorizationCode({
        code: 'the-code',
        redirectUri: 'https://app.bloombot.test/discord/callback',
        codeVerifier: 'the-verifier',
      })
    ).rejects.toThrow(/no usable access token/)
  })

  it('getUserGuilds throws when the guild-list endpoint answers 2xx with something other than a JSON array', async () => {
    server.respondToGuilds({ status: 200, body: { not: 'an array' } })

    await expect(client.getUserGuilds('a-user-access-token')).rejects.toThrow(
      /no usable JSON array/
    )
  })
})

// SRV-6: the four guild-write calls `apps/worker`'s scaffold handler builds
// on — proven at the REST layer against the loopback fake's own stateful
// guild store (`FakeDiscordServer`'s own module comment), one level below
// the handler's own idempotence/never-delete tests.
describe('listGuildChannels / listGuildRoles / createGuildCategory / createGuildChannel (SRV-6)', () => {
  it("lists a guild's existing channels and categories, camelCasing parent_id", async () => {
    server.setGuildChannels('guild-1', [
      { id: 'cat-1', type: 4, name: 'Week 1', parent_id: null },
      { id: 'chan-1', type: 0, name: 'general', parent_id: 'cat-1' },
    ])

    const channels = await client.listGuildChannels('bot-token', 'guild-1')

    expect(channels).toEqual([
      {
        id: 'cat-1',
        type: 4,
        name: 'Week 1',
        parentId: null,
        permissionOverwrites: [],
      },
      {
        id: 'chan-1',
        type: 0,
        name: 'general',
        parentId: 'cat-1',
        permissionOverwrites: [],
      },
    ])
    expect(server.requests[0]).toMatchObject({
      method: 'GET',
      path: '/guilds/guild-1/channels',
    })
    expect(server.requests[0]?.headers.authorization).toBe('Bot bot-token')
  })

  it("lists a guild's roles", async () => {
    server.setGuildRoles('guild-1', [
      { id: 'role-admins', name: 'course-admins' },
      { id: 'role-students', name: 'course-students' },
    ])

    const roles = await client.listGuildRoles('bot-token', 'guild-1')

    expect(roles).toEqual([
      { id: 'role-admins', name: 'course-admins' },
      { id: 'role-students', name: 'course-students' },
    ])
  })

  it('creates a category with the given permission overwrites, as a JSON POST with a Bot authorization', async () => {
    const overwrites = [
      { id: 'guild-1', type: 0 as const, allow: '0', deny: '1024' },
      { id: 'role-admins', type: 0 as const, allow: '3072', deny: '0' },
    ]

    const created = await client.createGuildCategory('bot-token', 'guild-1', {
      name: 'Week 1',
      permissionOverwrites: overwrites,
    })

    expect(created).toMatchObject({ type: 4, name: 'Week 1', parentId: null })
    expect(created.id).toEqual(expect.any(String))
    // Finding 4 of the SRV-6..8 rework: `parseChannel` now reads a channel's
    // own `permission_overwrites` back, not just `id`/`type`/`name`/`parentId`
    // — `apps/worker`'s scaffold handler needs this to report an existing
    // category or channel's actual privacy rather than merely the declared
    // one.
    expect(created.permissionOverwrites).toEqual(overwrites)
    expect(server.requests[0]).toMatchObject({
      method: 'POST',
      path: '/guilds/guild-1/channels',
      headers: expect.objectContaining({
        authorization: 'Bot bot-token',
        'content-type': 'application/json',
      }) as unknown,
    })
    expect(server.requests[0]?.body).toEqual({
      name: 'Week 1',
      type: 4,
      permission_overwrites: overwrites,
    })

    // The fake's own guild store actually holds it now — proven here, not
    // just asserted from the create call's own response, since SRV-7's
    // idempotence depends on a subsequent `listGuildChannels` seeing it.
    const channels = await client.listGuildChannels('bot-token', 'guild-1')
    expect(channels).toEqual([created])
  })

  it('creates a text channel inside a category, omitting permission_overwrites entirely when none is given so the channel inherits the category', async () => {
    const created = await client.createGuildChannel('bot-token', 'guild-1', {
      name: 'general',
      parentId: 'cat-1',
    })

    expect(created).toMatchObject({
      type: 0,
      name: 'general',
      parentId: 'cat-1',
    })
    expect(server.requests[0]?.body).toEqual({
      name: 'general',
      type: 0,
      parent_id: 'cat-1',
    })
    expect(server.requests[0]?.body).not.toHaveProperty('permission_overwrites')
  })

  it('creates an admin-only channel with its own explicit permission overwrites', async () => {
    const overwrites = [
      { id: 'guild-1', type: 0 as const, allow: '0', deny: '1024' },
      { id: 'role-admins', type: 0 as const, allow: '3072', deny: '0' },
    ]

    await client.createGuildChannel('bot-token', 'guild-1', {
      name: 'admins',
      parentId: 'cat-1',
      permissionOverwrites: overwrites,
    })

    expect(server.requests[0]?.body).toEqual({
      name: 'admins',
      type: 0,
      parent_id: 'cat-1',
      permission_overwrites: overwrites,
    })
  })

  it('listGuildChannels throws DiscordRequestError for a non-2xx response', async () => {
    server.respondToGuildChannels({ status: 500, body: { message: 'boom' } })

    await expect(
      client.listGuildChannels('bot-token', 'guild-1')
    ).rejects.toMatchObject(
      expect.objectContaining({ status: 500 }) as Partial<DiscordRequestError>
    )
  })

  it('createGuildCategory throws DiscordRequestError for a non-2xx response', async () => {
    server.respondToGuildChannels({
      status: 403,
      body: { message: 'Missing Permissions' },
    })

    await expect(
      client.createGuildCategory('bot-token', 'guild-1', {
        name: 'Week 1',
        permissionOverwrites: [],
      })
    ).rejects.toMatchObject(
      expect.objectContaining({ status: 403 }) as Partial<DiscordRequestError>
    )
  })
})
