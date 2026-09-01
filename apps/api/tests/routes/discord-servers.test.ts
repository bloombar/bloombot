/**
 * The Discord install flow, over HTTP (TEN-4): begin, complete, and TEN-6's
 * removal. No test in this file reaches Discord — `discordRestClient` is
 * always `createFakeDiscordRestClient(...)`, never the real adapter.
 */

import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import { discordServers, schema } from '@bloombot/db'

import { buildTestApp, TEST_PUBLIC_APP_URL } from '../helpers/build-test-app.js'
import {
  createFakeDiscordRestClient,
  FAKE_DISCORD_ACCESS_TOKEN,
} from '../helpers/fake-discord-rest-client.js'
import { createFakeLogger } from '../helpers/fake-logger.js'
import { seedSignedInCaller } from '../helpers/seed.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

const ADMIN_GUILD = {
  id: 'guild-1',
  name: 'Admin Guild',
  owner: false,
  permissions: '32', // MANAGE_GUILD
}
const NON_ADMIN_GUILD = {
  id: 'guild-1',
  name: 'Some Guild',
  owner: false,
  permissions: '0',
}
const BOT_MEMBER_GUILD = { id: 'guild-1', name: 'Admin Guild' }

/** Begins an install over HTTP and pulls the `state` value back out of the returned authorization URL — the same value a real front end would get back from Discord's own redirect. */
async function beginInstall(
  app: import('express').Express,
  organizationId: string,
  cookieHeader: string
): Promise<{ state: string; authorizationUrl: string; expiresAt: number }> {
  const response = await request(app)
    .post(`/organizations/${organizationId}/discord-servers/install/begin`)
    .set('Cookie', cookieHeader)
    .set('Origin', TEST_PUBLIC_APP_URL)
    .send({})
  expect(response.status).toBe(200)
  const body = response.body as { authorizationUrl: string; expiresAt: number }
  const state = new URL(body.authorizationUrl).searchParams.get('state')
  if (!state) throw new Error('test setup: authorizationUrl carried no state')
  return {
    state,
    authorizationUrl: body.authorizationUrl,
    expiresAt: body.expiresAt,
  }
}

describe('POST /organizations/:organizationId/discord-servers/install/begin', () => {
  it('returns an authorization URL carrying client_id, redirect_uri, state and a PKCE code_challenge', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const app = buildTestApp(testDb.db)

    const { authorizationUrl, expiresAt } = await beginInstall(
      app,
      caller.organizationId,
      caller.cookieHeader
    )

    const url = new URL(authorizationUrl)
    expect(url.searchParams.get('client_id')).toBe('test-discord-client-id')
    expect(url.searchParams.get('redirect_uri')).toBe(
      `${TEST_PUBLIC_APP_URL}/discord/callback`
    )
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')?.length).toBeGreaterThan(0)
    expect(expiresAt).toBeGreaterThan(Date.now())
  })
})

describe('POST /organizations/:organizationId/discord-servers/install/callback', () => {
  it('TEN-4: refuses a user who does not administer the guild, writing no binding', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const fakeDiscord = createFakeDiscordRestClient({
      userGuilds: [NON_ADMIN_GUILD],
      botGuilds: [BOT_MEMBER_GUILD],
    })
    const app = buildTestApp(testDb.db, { discordRestClient: fakeDiscord })
    const { state } = await beginInstall(
      app,
      caller.organizationId,
      caller.cookieHeader
    )

    const response = await request(app)
      .post(
        `/organizations/${caller.organizationId}/discord-servers/install/callback`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ code: 'the-code', state, guildId: 'guild-1' })

    expect(response.status).toBe(404)
    expect(
      discordServers.resolveDiscordServerBinding('guild-1', testDb.db)
    ).toBeUndefined()
  })

  it('TEN-4: the same user, with MANAGE_GUILD, succeeds and claims the binding', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const fakeDiscord = createFakeDiscordRestClient({
      userGuilds: [ADMIN_GUILD],
      botGuilds: [BOT_MEMBER_GUILD],
    })
    const app = buildTestApp(testDb.db, { discordRestClient: fakeDiscord })
    const { state } = await beginInstall(
      app,
      caller.organizationId,
      caller.cookieHeader
    )

    const response = await request(app)
      .post(
        `/organizations/${caller.organizationId}/discord-servers/install/callback`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ code: 'the-code', state, guildId: 'guild-1' })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ serverId: 'guild-1' })
    expect(
      discordServers.resolveDiscordServerBinding('guild-1', testDb.db)
    ).toMatchObject({
      organizationId: caller.organizationId,
      installedByAccountId: caller.accountId,
    })
  })

  it('TEN-4: owner (rather than MANAGE_GUILD) also succeeds', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const fakeDiscord = createFakeDiscordRestClient({
      userGuilds: [
        { id: 'guild-1', name: 'Owned Guild', owner: true, permissions: '0' },
      ],
      botGuilds: [BOT_MEMBER_GUILD],
    })
    const app = buildTestApp(testDb.db, { discordRestClient: fakeDiscord })
    const { state } = await beginInstall(
      app,
      caller.organizationId,
      caller.cookieHeader
    )

    const response = await request(app)
      .post(
        `/organizations/${caller.organizationId}/discord-servers/install/callback`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ code: 'the-code', state, guildId: 'guild-1' })

    expect(response.status).toBe(200)
  })

  it('refuses when the bot itself was never added to the guild, even though the caller administers it', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const fakeDiscord = createFakeDiscordRestClient({
      userGuilds: [ADMIN_GUILD],
      botGuilds: [], // the bot is not a member of guild-1
    })
    const app = buildTestApp(testDb.db, { discordRestClient: fakeDiscord })
    const { state } = await beginInstall(
      app,
      caller.organizationId,
      caller.cookieHeader
    )

    const response = await request(app)
      .post(
        `/organizations/${caller.organizationId}/discord-servers/install/callback`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ code: 'the-code', state, guildId: 'guild-1' })

    expect(response.status).toBe(404)
    expect(
      discordServers.resolveDiscordServerBinding('guild-1', testDb.db)
    ).toBeUndefined()
  })

  // TEN-4: "discards the user access token afterwards ... storing it is a
  // liability" — neither the database nor the log carries it anywhere.
  it('discards the user access token: no database row and no log line contains it', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    const fakeDiscord = createFakeDiscordRestClient({
      userGuilds: [ADMIN_GUILD],
      botGuilds: [BOT_MEMBER_GUILD],
    })
    const logger = createFakeLogger()
    const app = buildTestApp(testDb.db, {
      discordRestClient: fakeDiscord,
      logger,
    })
    const { state } = await beginInstall(
      app,
      caller.organizationId,
      caller.cookieHeader
    )

    const response = await request(app)
      .post(
        `/organizations/${caller.organizationId}/discord-servers/install/callback`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ code: 'the-code', state, guildId: 'guild-1' })
    expect(response.status).toBe(200)

    // Every table this flow could plausibly have written to.
    const allInstallStates = testDb.db
      .select()
      .from(schema.discordInstallStates)
      .all()
    const allBindings = testDb.db
      .select()
      .from(schema.discordServerBindings)
      .all()
    expect(JSON.stringify(allInstallStates)).not.toContain(
      FAKE_DISCORD_ACCESS_TOKEN
    )
    expect(JSON.stringify(allBindings)).not.toContain(FAKE_DISCORD_ACCESS_TOKEN)

    const everyLogCall = [...logger.infoCalls, ...logger.errorCalls]
    expect(JSON.stringify(everyLogCall)).not.toContain(
      FAKE_DISCORD_ACCESS_TOKEN
    )
  })

  describe('state and PKCE', () => {
    it('refuses a callback with an unknown state', async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInCaller(testDb.db)
      const app = buildTestApp(testDb.db)

      const response = await request(app)
        .post(
          `/organizations/${caller.organizationId}/discord-servers/install/callback`
        )
        .set('Cookie', caller.cookieHeader)
        .set('Origin', TEST_PUBLIC_APP_URL)
        .send({ code: 'the-code', state: 'made-up-state', guildId: 'guild-1' })

      expect(response.status).toBe(404)
    })

    it('refuses a replayed state — a second callback with the same state fails', async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInCaller(testDb.db)
      const fakeDiscord = createFakeDiscordRestClient({
        userGuilds: [ADMIN_GUILD],
        botGuilds: [BOT_MEMBER_GUILD],
      })
      const app = buildTestApp(testDb.db, { discordRestClient: fakeDiscord })
      const { state } = await beginInstall(
        app,
        caller.organizationId,
        caller.cookieHeader
      )

      const first = await request(app)
        .post(
          `/organizations/${caller.organizationId}/discord-servers/install/callback`
        )
        .set('Cookie', caller.cookieHeader)
        .set('Origin', TEST_PUBLIC_APP_URL)
        .send({ code: 'the-code', state, guildId: 'guild-1' })
      expect(first.status).toBe(200)

      const replayed = await request(app)
        .post(
          `/organizations/${caller.organizationId}/discord-servers/install/callback`
        )
        .set('Cookie', caller.cookieHeader)
        .set('Origin', TEST_PUBLIC_APP_URL)
        .send({ code: 'the-code', state, guildId: 'guild-1' })
      expect(replayed.status).toBe(404)
    })

    it('refuses an expired state', async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInCaller(testDb.db)
      const app = buildTestApp(testDb.db)
      const { state } = await beginInstall(
        app,
        caller.organizationId,
        caller.cookieHeader
      )

      // Back-date every install-state row's expiry directly — the cheapest
      // way to prove the callback's own expiry check, without a real wait.
      testDb.db
        .update(schema.discordInstallStates)
        .set({ expiresAt: Date.now() - 1 })
        .run()

      const response = await request(app)
        .post(
          `/organizations/${caller.organizationId}/discord-servers/install/callback`
        )
        .set('Cookie', caller.cookieHeader)
        .set('Origin', TEST_PUBLIC_APP_URL)
        .send({ code: 'the-code', state, guildId: 'guild-1' })

      expect(response.status).toBe(404)
    })

    it('sends the token exchange exactly the verifier that was stored for this state', async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInCaller(testDb.db)
      const fakeDiscord = createFakeDiscordRestClient({
        userGuilds: [ADMIN_GUILD],
        botGuilds: [BOT_MEMBER_GUILD],
      })
      const app = buildTestApp(testDb.db, { discordRestClient: fakeDiscord })
      const { state } = await beginInstall(
        app,
        caller.organizationId,
        caller.cookieHeader
      )
      const storedRow = testDb.db
        .select()
        .from(schema.discordInstallStates)
        .get()

      await request(app)
        .post(
          `/organizations/${caller.organizationId}/discord-servers/install/callback`
        )
        .set('Cookie', caller.cookieHeader)
        .set('Origin', TEST_PUBLIC_APP_URL)
        .send({ code: 'the-code', state, guildId: 'guild-1' })

      expect(fakeDiscord.exchangeCalls).toHaveLength(1)
      expect(fakeDiscord.exchangeCalls[0]?.codeVerifier).toBe(
        storedRow?.codeVerifier
      )
    })
  })

  // TEN-3: still holds through the flow — a server already actively bound
  // to a different organization is refused, and the refusal discloses
  // nothing about who holds it (the same 404 as every other refusal here).
  it('TEN-3: installing into a server already bound to a different organization is refused', async () => {
    testDb = createTestDatabase()
    const holder = seedSignedInCaller(testDb.db, {
      organizationName: 'Holder Org',
    })
    discordServers.claimDiscordServerBinding(
      holder.organizationId,
      { serverId: 'guild-1', installedByAccountId: holder.accountId },
      testDb.db
    )
    const caller = seedSignedInCaller(testDb.db, {
      organizationName: 'Installer Org',
    })
    const fakeDiscord = createFakeDiscordRestClient({
      userGuilds: [ADMIN_GUILD],
      botGuilds: [BOT_MEMBER_GUILD],
    })
    const app = buildTestApp(testDb.db, { discordRestClient: fakeDiscord })
    const { state } = await beginInstall(
      app,
      caller.organizationId,
      caller.cookieHeader
    )

    const response = await request(app)
      .post(
        `/organizations/${caller.organizationId}/discord-servers/install/callback`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ code: 'the-code', state, guildId: 'guild-1' })

    expect(response.status).toBe(404)
    // Untouched: still the original holder's binding.
    expect(
      discordServers.resolveDiscordServerBinding('guild-1', testDb.db)
    ).toMatchObject({ organizationId: holder.organizationId })
  })
})

describe('discordServers.remove over HTTP (TEN-6)', () => {
  it('marks the binding inactive, and a re-installation restores a working one', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInCaller(testDb.db)
    discordServers.claimDiscordServerBinding(
      caller.organizationId,
      { serverId: 'guild-1', installedByAccountId: caller.accountId },
      testDb.db
    )
    const app = buildTestApp(testDb.db)

    const removeResponse = await request(app)
      .post(
        `/organizations/${caller.organizationId}/actions/discordServers.remove`
      )
      .set('Cookie', caller.cookieHeader)
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ serverId: 'guild-1' })
    expect(removeResponse.status).toBe(200)
    expect(
      discordServers.resolveDiscordServerBinding('guild-1', testDb.db)
    ).toBeUndefined()

    const reclaimed = discordServers.claimDiscordServerBinding(
      caller.organizationId,
      { serverId: 'guild-1', installedByAccountId: caller.accountId },
      testDb.db
    )
    expect(reclaimed).toMatchObject({
      serverId: 'guild-1',
      organizationId: caller.organizationId,
    })
  })
})
