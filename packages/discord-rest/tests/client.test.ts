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

describe('getCurrentUser (LINK-7)', () => {
  it("sends the caller's token as a Bearer header and returns the fake's own user identity", async () => {
    server.setCurrentUser({ id: '12345', username: 'a-student' })

    const user = await client.getCurrentUser('a-user-access-token')

    expect(user).toEqual({ id: '12345', username: 'a-student' })
    expect(server.requests[0]?.path).toBe('/users/@me')
    expect(server.requests[0]?.headers.authorization).toBe(
      'Bearer a-user-access-token'
    )
  })

  it('throws DiscordRequestError for a non-2xx response', async () => {
    server.respondToCurrentUser({
      status: 401,
      body: { message: '401: Unauthorized' },
    })

    await expect(
      client.getCurrentUser('an-expired-token')
    ).rejects.toMatchObject(
      expect.objectContaining({ status: 401 }) as Partial<DiscordRequestError>
    )
  })

  it('throws when a 2xx response has no usable id/username', async () => {
    server.setCurrentUser({ avatar: null })

    await expect(client.getCurrentUser('a-user-access-token')).rejects.toThrow(
      /no usable user/
    )
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

describe('listGuildMembers (ROST-10/ROST-11)', () => {
  it("resolves a member's id, username and display-name fallback chain (nick, then global_name, then username)", async () => {
    server.setGuildMembers('guild-1', [
      {
        user: { id: '1', username: 'adalovelace', global_name: 'Ada L.' },
        nick: 'Ada',
      },
      {
        user: { id: '2', username: 'alanturing', global_name: 'Alan T.' },
        // No nickname set — falls back to global_name.
      },
      {
        user: { id: '3', username: 'gracehopper' },
        // Neither nickname nor global_name — falls back to username.
      },
    ])

    const members = await client.listGuildMembers('bot-token', 'guild-1')

    expect(members).toEqual([
      { id: '1', username: 'adalovelace', displayName: 'Ada' },
      { id: '2', username: 'alanturing', displayName: 'Alan T.' },
      { id: '3', username: 'gracehopper', displayName: 'gracehopper' },
    ])
    expect(server.requests[0]?.headers.authorization).toBe('Bot bot-token')
  })

  // The same page-walking discipline `getUserGuilds`/`getBotGuilds` already
  // prove above (finding 3 of the TEN-4..6 rework) — a guild with more
  // members than one page must not be silently truncated to the first.
  it('walks every page when the member list is larger than one page', async () => {
    const fullList = Array.from({ length: 1200 }, (_, i) => ({
      user: { id: String(i + 1).padStart(4, '0'), username: `member-${i + 1}` },
    }))
    server.setGuildMembers('guild-1', fullList)

    const members = await client.listGuildMembers('bot-token', 'guild-1')

    expect(members).toHaveLength(1200)
    const memberRequests = server.requests.filter((r) =>
      r.path.startsWith('/guilds/guild-1/members')
    )
    expect(memberRequests).toHaveLength(2)
    expect(memberRequests[0]?.path).not.toContain('after=')
    expect(memberRequests[1]?.path).toContain(`after=${fullList[999]?.user.id}`)
  })

  it('drops a malformed entry rather than throwing', async () => {
    server.setGuildMembers('guild-1', [
      { user: { id: '1', username: 'adalovelace' } },
      { nick: 'no user object at all' },
    ])

    const members = await client.listGuildMembers('bot-token', 'guild-1')

    expect(members).toEqual([
      { id: '1', username: 'adalovelace', displayName: 'adalovelace' },
    ])
  })

  // Rework finding 9: a malformed entry landing on an otherwise-*full* page
  // used to end pagination early — the loop compared the parsed (already
  // filtered) page length against the limit, so one bad entry made a full
  // page of 1000 look like a short 999-entry page and the walk stopped
  // there. A 1200-member guild lost its entire second page this way.
  it('keeps paging past a page that only looks short because one of its entries was malformed', async () => {
    const fullList: unknown[] = Array.from({ length: 1200 }, (_, i) => ({
      user: { id: String(i + 1).padStart(4, '0'), username: `member-${i + 1}` },
    }))
    // The last entry of the first raw page (index 999) is malformed — no
    // `user` object at all — so `parseGuildMemberList` drops it, leaving
    // 999 *parsed* entries on a page Discord itself sent as a full 1000.
    const withOneMalformedEntry = [...fullList]
    withOneMalformedEntry[999] = { nick: 'malformed — no user object' }
    server.setGuildMembers('guild-1', withOneMalformedEntry)

    const members = await client.listGuildMembers('bot-token', 'guild-1')

    // 1200 raw entries, one dropped — 1199 usable members, not 999.
    expect(members).toHaveLength(1199)
    const memberRequests = server.requests.filter((r) =>
      r.path.startsWith('/guilds/guild-1/members')
    )
    // Still two requests — the malformed entry did not make the walk stop
    // after the first.
    expect(memberRequests).toHaveLength(2)
  })
})

// Rework finding 5 of the ROST-9..12 rework — `client.ts`'s one deliberate
// exception to "this package only ever `GET`s or `POST`s a guild write",
// added for ROST-5's late-joining student. Proven at the REST layer here,
// one level below `roster-import.ts`'s own use of it.
describe('grantChannelMemberAccess (rework finding 5)', () => {
  it('PUTs exactly one member overwrite onto the named channel, with the same bits a channel gets at creation', async () => {
    const createdChannel = await client.createGuildCategory(
      'bot-token',
      'guild-1',
      { name: 'Week 1', permissionOverwrites: [] }
    )
    server.requests.length = 0 // Only this call's own request matters below.

    await client.grantChannelMemberAccess(
      'bot-token',
      createdChannel.id,
      'student-42'
    )

    expect(server.requests).toHaveLength(1)
    expect(server.requests[0]).toMatchObject({
      method: 'PUT',
      path: `/channels/${createdChannel.id}/permissions/student-42`,
      headers: expect.objectContaining({
        authorization: 'Bot bot-token',
        'content-type': 'application/json',
      }) as unknown,
    })
    // The same `allow`/`deny`/`type` a channel is created with, via
    // `allowMemberOverwrite` — this grants nothing wider, only later.
    expect(server.requests[0]?.body).toEqual({
      type: 1,
      allow: (0x400n | 0x800n).toString(),
      deny: '0',
    })
  })

  it('throws DiscordRequestError for a non-2xx response, the same as every other write in this package', async () => {
    server.respondToChannelPermissionPut({
      status: 403,
      body: { message: 'Missing Permissions' },
    })

    await expect(
      client.grantChannelMemberAccess('bot-token', 'chan-1', 'student-42')
    ).rejects.toMatchObject(
      expect.objectContaining({ status: 403 }) as Partial<DiscordRequestError>
    )
  })

  // Structural proof this narrow write cannot become a general edit verb:
  // nothing this package sends to `PUT /channels/{id}/permissions/{id}`
  // carries a channel's own `name`/`parent_id` at all — there is no method
  // on `DiscordRestClient` that could, and this asserts the one PUT this
  // package does make stays that narrow in practice, not just in the type
  // signature.
  it('sends nothing but the one member overwrite — no channel name, no parent, no other target', async () => {
    await client.grantChannelMemberAccess('bot-token', 'chan-1', 'student-42')

    const body = server.requests[0]?.body as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['allow', 'deny', 'type'])
  })
})
