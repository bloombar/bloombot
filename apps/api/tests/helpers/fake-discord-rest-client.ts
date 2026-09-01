/**
 * Test helper: an in-memory `DiscordRestClient` (`@bloombot/discord-rest`'s
 * port) — no loopback server, no network at all, the same "a plain object
 * implementing the port" shape `build-test-app.ts#createFakeGoogleVerifier`
 * already uses for `GoogleIdTokenVerifier`. Records every call so a test can
 * assert what `routes/discord-servers.ts` actually sent — in particular,
 * that the returned access token is never handed to anything beyond the two
 * calls it exists for (TEN-4: discarded afterward).
 */

import type {
  DiscordChannel,
  DiscordGuildMember,
  DiscordGuildSummary,
  DiscordOAuthToken,
  DiscordRestClient,
  DiscordRole,
} from '@bloombot/discord-rest'

export interface ExchangeCall {
  code: string
  redirectUri: string
  codeVerifier: string
}

export interface FakeDiscordRestClient extends DiscordRestClient {
  exchangeCalls: ExchangeCall[]
  getUserGuildsCalls: string[]
  getBotGuildsCalls: string[]
}

export interface FakeDiscordRestClientOptions {
  /** The access token `exchangeAuthorizationCode` resolves with. Defaults to a distinctive, greppable value so a test can prove it never reaches a log or the database. */
  accessToken?: string
  /** What `getUserGuilds` resolves with — the caller's own guild list, `owner`/`permissions` and all. */
  userGuilds?: DiscordGuildSummary[]
  /** What `getBotGuilds` resolves with — the guilds the bot itself is a member of. */
  botGuilds?: DiscordGuildSummary[]
  /** When set, `exchangeAuthorizationCode` rejects with this instead of resolving — a Discord REST failure a route must let propagate to `errorMiddleware`, not swallow. */
  exchangeError?: Error
}

export const FAKE_DISCORD_ACCESS_TOKEN = 'fake-discord-user-access-token'

export function createFakeDiscordRestClient(
  options: FakeDiscordRestClientOptions = {}
): FakeDiscordRestClient {
  const exchangeCalls: ExchangeCall[] = []
  const getUserGuildsCalls: string[] = []
  const getBotGuildsCalls: string[] = []
  const accessToken = options.accessToken ?? FAKE_DISCORD_ACCESS_TOKEN

  return {
    exchangeCalls,
    getUserGuildsCalls,
    getBotGuildsCalls,

    exchangeAuthorizationCode(input): Promise<DiscordOAuthToken> {
      exchangeCalls.push(input)
      if (options.exchangeError) return Promise.reject(options.exchangeError)
      return Promise.resolve({
        accessToken,
        tokenType: 'Bearer',
        scope: 'identify guilds bot',
        expiresIn: 604800,
      })
    },

    getUserGuilds(userAccessToken): Promise<DiscordGuildSummary[]> {
      getUserGuildsCalls.push(userAccessToken)
      return Promise.resolve(options.userGuilds ?? [])
    },

    getBotGuilds(botToken): Promise<DiscordGuildSummary[]> {
      getBotGuildsCalls.push(botToken)
      return Promise.resolve(options.botGuilds ?? [])
    },

    // SRV-6's guild-management calls, and ROST-10/ROST-11's
    // `listGuildMembers` alongside them — `apps/api` never scaffolds a
    // server or imports a roster itself (both are `apps/worker`'s own
    // handlers, over the queue), so nothing in this app's routes calls
    // these; they exist only so this fake keeps satisfying
    // `DiscordRestClient` as that port grows.
    listGuildChannels(): Promise<DiscordChannel[]> {
      return Promise.resolve([])
    },
    listGuildRoles(): Promise<DiscordRole[]> {
      return Promise.resolve([])
    },
    listGuildMembers(): Promise<DiscordGuildMember[]> {
      return Promise.resolve([])
    },
    createGuildCategory(_botToken, _guildId, input): Promise<DiscordChannel> {
      return Promise.resolve({
        id: 'fake-category-id',
        type: 4,
        name: input.name,
        parentId: null,
      })
    },
    createGuildChannel(_botToken, _guildId, input): Promise<DiscordChannel> {
      return Promise.resolve({
        id: 'fake-channel-id',
        type: 0,
        name: input.name,
        parentId: input.parentId,
      })
    },
  }
}
