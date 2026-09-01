/**
 * The Discord install flow, over HTTP (TEN-4): begin, complete, and TEN-6's
 * removal. No test in this file reaches Discord — `discordRestClient` is
 * always `createFakeDiscordRestClient(...)`, never the real adapter.
 */

import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import { discordServers, memberships, schema } from '@bloombot/db'
import { DiscordRequestError } from '@bloombot/discord-rest'

import { buildTestApp, TEST_PUBLIC_APP_URL } from '../helpers/build-test-app.js'
import {
  createFakeDiscordRestClient,
  FAKE_DISCORD_ACCESS_TOKEN,
} from '../helpers/fake-discord-rest-client.js'
import { createFakeLogger } from '../helpers/fake-logger.js'
import {
  seedOtherOrganization,
  seedSecondCallerInOrganization,
  seedSignedInCaller,
} from '../helpers/seed.js'
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

  // Findings 4 and 7 of the TEN-4..6 rework: an expired or already-redeemed
  // authorization code answers with an upstream 4xx (`invalid_grant`, most
  // commonly) — `exchangeError` (`fake-discord-rest-client.ts`) is what
  // exercises that path; it existed already but nothing used it (finding
  // 7). Before the fix, this fell through to `middleware/errors.ts`'s
  // unexpected-failure branch: a `500` and an `error`-level log line any
  // authenticated member could grow without bound just by resubmitting a
  // code that already failed.
  describe('an upstream 4xx from the token exchange itself', () => {
    it('is refused the same way every other rejection in this flow is (404), not a 500', async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInCaller(testDb.db)
      const fakeDiscord = createFakeDiscordRestClient({
        exchangeError: new DiscordRequestError(400, {
          error: 'invalid_grant',
        }),
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
        .send({ code: 'an-expired-code', state, guildId: 'guild-1' })

      expect(response.status).toBe(404)
      expect(response.body).toEqual({ error: 'action_refused' })
      expect(
        discordServers.resolveDiscordServerBinding('guild-1', testDb.db)
      ).toBeUndefined()
    })

    it('is logged at warn, not error — the class of thing an authenticated caller can trigger just by retrying, not an unexpected failure', async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInCaller(testDb.db)
      const fakeDiscord = createFakeDiscordRestClient({
        exchangeError: new DiscordRequestError(400, {
          error: 'invalid_grant',
          // Discord's own token-exchange error body can echo the
          // authorization code back — this must not reach the log either.
          error_description: 'the-secret-authorization-code',
        }),
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
        .send({
          code: 'the-secret-authorization-code',
          state,
          guildId: 'guild-1',
        })
      expect(response.status).toBe(404)

      expect(logger.errorCalls).toHaveLength(0)
      expect(logger.warnCalls).toHaveLength(1)
      expect(JSON.stringify(logger.warnCalls[0])).not.toContain(
        'the-secret-authorization-code'
      )
    })

    it('a genuine Discord REST failure elsewhere in the flow (not the token exchange) still reaches errorMiddleware as a 500 — this carve-out is for the exchange only', async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInCaller(testDb.db)
      const fakeDiscord = createFakeDiscordRestClient({
        userGuilds: [ADMIN_GUILD],
        botGuilds: [BOT_MEMBER_GUILD],
      })
      // A non-2xx from the *guild list* read, not the token exchange.
      fakeDiscord.getUserGuilds = () =>
        Promise.reject(new DiscordRequestError(503, { error: 'unavailable' }))
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

      expect(response.status).toBe(500)
    })
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

    // Finding 1 of the TEN-4..6 rework: `state` is a URL query parameter,
    // so it leaks the way any of them can — browser history on a shared
    // machine, a support screenshot, a proxy log — and this file's own
    // callback used to check only that the state resolved to the *right
    // organization*, never the right *account*. Two members of the same
    // organization must not be interchangeable just because a membership
    // check alone passes for either of them.
    it('refuses a callback posted by a different account than the one that began the install, even though both are members of the same organization', async () => {
      testDb = createTestDatabase()
      const owner = seedSignedInCaller(testDb.db)
      const assistant = seedSecondCallerInOrganization(
        testDb.db,
        owner.organizationId
      )
      const fakeDiscord = createFakeDiscordRestClient({
        userGuilds: [ADMIN_GUILD],
        botGuilds: [BOT_MEMBER_GUILD],
      })
      const app = buildTestApp(testDb.db, { discordRestClient: fakeDiscord })
      // The owner begins the install — this is the state that would leak.
      const { state } = await beginInstall(
        app,
        owner.organizationId,
        owner.cookieHeader
      )

      // The assistant — a real member of the same organization, with their
      // own session and their own guild list — posts the owner's state back.
      const response = await request(app)
        .post(
          `/organizations/${owner.organizationId}/discord-servers/install/callback`
        )
        .set('Cookie', assistant.cookieHeader)
        .set('Origin', TEST_PUBLIC_APP_URL)
        .send({ code: 'the-code', state, guildId: 'guild-1' })

      expect(response.status).toBe(404)
      expect(
        discordServers.resolveDiscordServerBinding('guild-1', testDb.db)
      ).toBeUndefined()

      // The owner's own attempt is spent too — it was single-use, and the
      // assistant's replay consumed it, exactly as any other invalid
      // caller's replay would (TEN-4's own single-use guarantee).
      const ownersOwnRetry = await request(app)
        .post(
          `/organizations/${owner.organizationId}/discord-servers/install/callback`
        )
        .set('Cookie', owner.cookieHeader)
        .set('Origin', TEST_PUBLIC_APP_URL)
        .send({ code: 'the-code', state, guildId: 'guild-1' })
      expect(ownersOwnRetry.status).toBe(404)
    })

    // The organization half of the same check, which — unlike the account
    // half above — already existed in code before this rework, but had no
    // test of its own reachable for an account that actually belongs to
    // both organizations (the case where a membership check alone would
    // let the request past `routes/discord-servers.ts`'s own membership
    // guard for either organization).
    it('refuses a callback whose state resolves to a different organization than the URL names, even for an account that is a member of both', async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInCaller(testDb.db, {
        organizationName: 'Home Org',
      })
      const otherOrganizationId = seedOtherOrganization(testDb.db)
      // The same account joins the second organization too.
      memberships.createMembership(
        otherOrganizationId,
        caller.accountId,
        'assistant',
        testDb.db
      )
      // A fake that would let the install succeed (`ADMIN_GUILD`/
      // `BOT_MEMBER_GUILD`, the same as the success-path tests above) — so
      // that a bypassed organization check would actually show up as a
      // `200`, not an accidental `404` from an empty default guild list
      // masking the very thing this test means to prove.
      const fakeDiscord = createFakeDiscordRestClient({
        userGuilds: [ADMIN_GUILD],
        botGuilds: [BOT_MEMBER_GUILD],
      })
      const app = buildTestApp(testDb.db, { discordRestClient: fakeDiscord })
      // Begun against the caller's home organization — the state is scoped
      // to it.
      const { state } = await beginInstall(
        app,
        caller.organizationId,
        caller.cookieHeader
      )

      // Posted against the *other* organization's own URL, with the same,
      // valid session — the membership check for `otherOrganizationId`
      // passes, so only the state's own organization check can refuse this.
      const response = await request(app)
        .post(
          `/organizations/${otherOrganizationId}/discord-servers/install/callback`
        )
        .set('Cookie', caller.cookieHeader)
        .set('Origin', TEST_PUBLIC_APP_URL)
        .send({ code: 'the-code', state, guildId: 'guild-1' })

      expect(response.status).toBe(404)
      expect(
        discordServers.resolveDiscordServerBinding('guild-1', testDb.db)
      ).toBeUndefined()
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
