/**
 * `DiscordRestClient` (TEN-4, SRV-6) — the port the install flow and, this
 * slice, server scaffolding depend on, and `createDiscordRestClient`, the
 * real implementation behind it. TEN-4's own three calls — exchange an
 * authorization code for a user access token, read that user's own guild
 * list (to check the `MANAGE_GUILD`/owner bit — `permissions.ts`), and read
 * the bot's own guild list (to confirm the bot the exchange just installed
 * is actually a member of the guild being claimed) — plus SRV-6's four: list
 * a guild's channels and roles, and create a category or a channel. Every
 * request's base URL comes from `CONFIG.DISCORD_API_BASE`/
 * `CONFIG.DISCORD_OAUTH_BASE` (or an explicit override, for a test) — never a
 * literal in this file, the same `packages/openai`'s own `client.ts` holds
 * itself to (QA-2), proven here by `tests/no-vendor-hostname.test.ts`.
 *
 * SRV-8's "never delete" is made structural here, not merely by convention:
 * this interface has no method that edits or removes a category or channel
 * at all — a category or channel this client creates cannot later be
 * renamed or deleted through it, whatever a handler built on top of it might
 * otherwise want to do. `apps/worker/src/handlers/discord-scaffold.ts` is
 * this slice's only caller of the four guild-write calls below, and it is
 * refused the means to delete anything by this file, not merely asked
 * nicely not to.
 */

import { CONFIG } from '@bloombot/config'

import type { DiscordPermissionOverwrite } from './channel-overwrites.js'
import { getJson, postForm, postJson, type RequestOptions } from './http.js'
import type { DiscordGuildSummary } from './permissions.js'

/** What a successful token exchange returns. */
export interface DiscordOAuthToken {
  accessToken: string
  tokenType: string
  scope: string
  expiresIn: number
}

/** Thrown when Discord answers a call with a non-2xx status — callers decide how to treat it (TEN-4's callback refuses the whole install the same way it refuses an unknown state); this file adds no interpretation of its own. */
export class DiscordRequestError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    super(`Discord request failed with status ${status}`)
    this.name = 'DiscordRequestError'
    this.status = status
    // `body` (an OAuth `error`/`error_description` pair, typically) is
    // deliberately not interpolated into `message` — the caller that wants
    // it can read `.body`, but a log line built from `.message` alone must
    // never end up carrying whatever Discord echoed back, which on a token
    // exchange failure can include the authorization code itself.
    //
    // Finding 5 of the TEN-4..6 rework: keeping `body` out of `message`
    // was not enough — pino's default `err` serializer
    // (`errorMiddleware`'s `logger.error({ err: error }, ...)`) copies an
    // error's own *enumerable* properties, `body` included, straight into
    // the log line regardless of what `message` says. `Object.defineProperty`
    // with `enumerable: false` is what actually keeps it out: `error.body`
    // still reads normally for the one caller that is supposed to see it
    // (`routes/discord-servers.ts`'s own token-exchange `catch`), but
    // `JSON.stringify`, `pino.stdSerializers.err`, and anything else that
    // walks an object's own enumerable keys skips it.
    Object.defineProperty(this, 'body', {
      value: body,
      enumerable: false,
      writable: true,
      configurable: true,
    })
  }
}

/** A category or text channel, as SRV-6's guild-write calls read and return it — Discord's own channel object, narrowed to the fields a scaffold run matches and creates by (`type`, `name`, `parentId`), tolerant of fields this package does not read. */
export interface DiscordChannel {
  id: string
  /** Discord's own channel-type enum — `4` (`GUILD_CATEGORY`) or `0` (`GUILD_TEXT`) are the only two this package ever creates or reads meaningfully; see `CHANNEL_TYPE_CATEGORY`/`CHANNEL_TYPE_TEXT` below. */
  type: number
  name: string
  /** The owning category's id, or `null` for a category itself (or an uncategorized channel, which SRV-6 never creates). */
  parentId: string | null
}

/** A guild role, as `listGuildRoles` returns it — enough for `apps/worker`'s scaffold handler to resolve a course's `adminsRole`/`studentsRole` names to the ids `denyEveryoneOverwrite`/`allowRoleOverwrite` (`channel-overwrites.ts`) need. */
export interface DiscordRole {
  id: string
  name: string
}

export interface DiscordRestClient {
  /**
   * Exchange an authorization code for a user access token (RFC 6749 §4.1.3,
   * with PKCE's `code_verifier` — RFC 7636 §4.5). The token this returns is
   * used immediately by the caller and then discarded (TEN-4: "nothing needs
   * it, and storing it is a liability") — this client itself never persists
   * or logs it either.
   */
  exchangeAuthorizationCode(input: {
    code: string
    redirectUri: string
    codeVerifier: string
  }): Promise<DiscordOAuthToken>

  /** The authenticated user's own guilds — `Authorization: Bearer <accessToken>`. Each entry's `owner`/`permissions` is what TEN-4's admin check reads (`permissions.ts#administersGuild`). */
  getUserGuilds(userAccessToken: string): Promise<DiscordGuildSummary[]>

  /** The bot's own guilds — `Authorization: Bot <botToken>`. Used to confirm the bot is actually a member of the guild an install is being claimed for, not merely that the installing user administers it. */
  getBotGuilds(botToken: string): Promise<DiscordGuildSummary[]>

  /** Every category and channel currently in a guild (SRV-6) — `apps/worker`'s scaffold handler matches a course's declared categories/channels against this list by name before creating anything. `Authorization: Bot <botToken>` — guild management is bot-only, unlike the OAuth-scoped calls above. */
  listGuildChannels(
    botToken: string,
    guildId: string
  ): Promise<DiscordChannel[]>

  /** Every role in a guild (SRV-2) — resolves a course's `adminsRole`/`studentsRole` names to ids. A name that resolves to nothing is the caller's to report (SRV-2's "skipped rather than treated as fatal"), not this method's — it simply omits what it does not find, the same as the real endpoint. */
  listGuildRoles(botToken: string, guildId: string): Promise<DiscordRole[]>

  /**
   * Create a category (SRV-1, SRV-2) with `permissionOverwrites` applied at
   * creation — `discord_manager.py`'s own create-then-`category.edit(
   * overwrites=...)` two-step, done here in the one call Discord's create
   * endpoint already supports. See this file's own module comment for why
   * SRV-8's "never delete" needs no guard here: there is no companion method
   * that edits or removes a category this (or any previous) call created.
   */
  createGuildCategory(
    botToken: string,
    guildId: string,
    input: { name: string; permissionOverwrites: DiscordPermissionOverwrite[] }
  ): Promise<DiscordChannel>

  /**
   * Create a text channel inside a category (SRV-3, SRV-4). `permissionOverwrites`
   * omitted (the common case) lets the channel inherit its category's — Discord's
   * own permission cascade computes that from the category alone, so a
   * channel with no overwrites of its own is not a distinct case this client
   * has to construct. Supplied only for an admin-only channel (SRV-3), whose
   * own overwrite must differ from its category's.
   */
  createGuildChannel(
    botToken: string,
    guildId: string,
    input: {
      name: string
      parentId: string
      permissionOverwrites?: DiscordPermissionOverwrite[]
    }
  ): Promise<DiscordChannel>
}

export interface CreateDiscordRestClientOptions {
  /** The Discord application id — Discord's "client id" and "application id" are the same value. */
  clientId: string
  /** The Discord application's OAuth client secret. Never logged, never defaulted — a missing value is the caller's mistake to surface, not this adapter's to guess at. */
  clientSecret: string
  /** Defaults to `CONFIG.DISCORD_API_BASE` (QA-2) — read here, at construction, not at module load (PLAT-5). */
  apiBase?: string
  /** Defaults to `CONFIG.DISCORD_OAUTH_BASE`. */
  oauthBase?: string
  /** Defaults to 10s. */
  timeoutMs?: number
  /** Defaults to the global `fetch` — overridable so a test can point every call at a loopback fake. */
  fetchFn?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 10_000

// Finding 3 of the TEN-4..6 rework: Discord's own `/users/@me/guilds`
// endpoint (whether read with a `Bearer` or a `Bot` token) returns one page
// at a time — up to `limit` entries, `200` being both Discord's own default
// and its own maximum — sorted ascending by id, paged forward with an
// `after=<last id seen>` cursor. Reading only the first page meant an
// install into any guild past the 200th the caller (or the bot) belongs to
// was refused exactly the way "you do not administer this server" is
// refused — silently, and permanently, since nothing about that guild ever
// changes to make a retry succeed.
const GUILD_LIST_PAGE_LIMIT = 200
// A page bound, not a guild-count bound: this is "how many round trips
// `getGuilds` will make before giving up and returning what it has",
// generous enough that no real account or bot approaches it (50 pages *
// 200 = 10,000 guilds) while still keeping a misbehaving upstream — one
// that, say, never stops returning full pages — from turning a single call
// into an unbounded loop.
const GUILD_LIST_MAX_PAGES = 50

// Discord's own channel-type enum (API v10) — the two values SRV-6 ever
// creates. `createGuildCategory`/`createGuildChannel` send exactly one of
// these, never a caller-supplied type: this package creates a course's
// declared structure, not an arbitrary channel.
const CHANNEL_TYPE_GUILD_TEXT = 0
const CHANNEL_TYPE_GUILD_CATEGORY = 4

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '')
}

/** Parse a token-exchange success body into `DiscordOAuthToken`'s camelCase shape — Discord's own JSON uses snake_case. */
function parseOAuthToken(body: unknown): DiscordOAuthToken {
  const payload = body as {
    access_token?: unknown
    token_type?: unknown
    scope?: unknown
    expires_in?: unknown
  }
  if (
    typeof payload.access_token !== 'string' ||
    typeof payload.token_type !== 'string'
  ) {
    throw new Error(
      'Discord token exchange returned a 2xx response with no usable access token'
    )
  }
  return {
    accessToken: payload.access_token,
    tokenType: payload.token_type,
    scope: typeof payload.scope === 'string' ? payload.scope : '',
    expiresIn: typeof payload.expires_in === 'number' ? payload.expires_in : 0,
  }
}

/** Parse a guild-list success body — an array of guild summaries, tolerant of fields this package does not read. */
function parseGuildList(body: unknown): DiscordGuildSummary[] {
  if (!Array.isArray(body)) {
    throw new Error(
      'Discord guild list returned a 2xx response with no usable JSON array'
    )
  }
  return body as DiscordGuildSummary[]
}

/** Parse one Discord channel object — snake_case `parent_id` into this package's own camelCase `parentId`, tolerant of every other field Discord sends and this package does not read. */
function parseChannel(body: unknown): DiscordChannel {
  const payload = body as {
    id?: unknown
    type?: unknown
    name?: unknown
    parent_id?: unknown
  }
  if (
    typeof payload.id !== 'string' ||
    typeof payload.type !== 'number' ||
    typeof payload.name !== 'string'
  ) {
    throw new Error(
      'Discord channel response returned a 2xx response with no usable channel'
    )
  }
  return {
    id: payload.id,
    type: payload.type,
    name: payload.name,
    parentId: typeof payload.parent_id === 'string' ? payload.parent_id : null,
  }
}

/** Parse a channel-list success body (`GET /guilds/{id}/channels`) — every category and channel in a guild, in the shape `parseChannel` gives one. */
function parseChannelList(body: unknown): DiscordChannel[] {
  if (!Array.isArray(body)) {
    throw new Error(
      'Discord channel list returned a 2xx response with no usable JSON array'
    )
  }
  return body.map(parseChannel)
}

/** Parse a role-list success body (`GET /guilds/{id}/roles`) — tolerant of fields this package does not read (colour, permissions, position, ...). */
function parseRoleList(body: unknown): DiscordRole[] {
  if (!Array.isArray(body)) {
    throw new Error(
      'Discord role list returned a 2xx response with no usable JSON array'
    )
  }
  return body as DiscordRole[]
}

/** Build a `DiscordRestClient` backed by the real Discord API (or a loopback fake standing in for it, via `apiBase`/`oauthBase`/`fetchFn`). */
export function createDiscordRestClient(
  options: CreateDiscordRestClientOptions
): DiscordRestClient {
  const apiBase = stripTrailingSlashes(
    options.apiBase ?? CONFIG.DISCORD_API_BASE
  )
  const oauthBase = stripTrailingSlashes(
    options.oauthBase ?? CONFIG.DISCORD_OAUTH_BASE
  )
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchFn = options.fetchFn ?? fetch
  const requestOptions: RequestOptions = { fetchFn, timeoutMs }

  /**
   * Read every page of `/users/@me/guilds` (finding 3 of the TEN-4..6
   * rework) — the module comment above `GUILD_LIST_PAGE_LIMIT` explains
   * why a single page is not enough. Stops the moment a page comes back
   * shorter than the limit (Discord's own signal that it was the last one)
   * rather than always making `GUILD_LIST_MAX_PAGES` requests.
   */
  async function getGuilds(
    authorization: string
  ): Promise<DiscordGuildSummary[]> {
    const guilds: DiscordGuildSummary[] = []
    let after: string | undefined
    for (let page = 0; page < GUILD_LIST_MAX_PAGES; page++) {
      const query = new URLSearchParams({
        limit: String(GUILD_LIST_PAGE_LIMIT),
      })
      if (after) query.set('after', after)
      const response = await getJson(
        `${apiBase}/users/@me/guilds?${query.toString()}`,
        authorization,
        requestOptions
      )
      if (!response.ok)
        throw new DiscordRequestError(response.status, response.body)
      const pageGuilds = parseGuildList(response.body)
      guilds.push(...pageGuilds)
      if (pageGuilds.length < GUILD_LIST_PAGE_LIMIT) break
      after = pageGuilds[pageGuilds.length - 1]?.id
      // No `id` to page from — nothing left to ask for, however this page
      // came to be exactly `GUILD_LIST_PAGE_LIMIT` long.
      if (!after) break
    }
    return guilds
  }

  return {
    async exchangeAuthorizationCode(input): Promise<DiscordOAuthToken> {
      const response = await postForm(
        `${oauthBase}/token`,
        {
          grant_type: 'authorization_code',
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code: input.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.codeVerifier,
        },
        requestOptions
      )
      if (!response.ok) {
        throw new DiscordRequestError(response.status, response.body)
      }
      return parseOAuthToken(response.body)
    },

    getUserGuilds: (userAccessToken) => getGuilds(`Bearer ${userAccessToken}`),
    getBotGuilds: (botToken) => getGuilds(`Bot ${botToken}`),

    async listGuildChannels(botToken, guildId): Promise<DiscordChannel[]> {
      const response = await getJson(
        `${apiBase}/guilds/${guildId}/channels`,
        `Bot ${botToken}`,
        requestOptions
      )
      if (!response.ok) {
        throw new DiscordRequestError(response.status, response.body)
      }
      return parseChannelList(response.body)
    },

    async listGuildRoles(botToken, guildId): Promise<DiscordRole[]> {
      const response = await getJson(
        `${apiBase}/guilds/${guildId}/roles`,
        `Bot ${botToken}`,
        requestOptions
      )
      if (!response.ok) {
        throw new DiscordRequestError(response.status, response.body)
      }
      return parseRoleList(response.body)
    },

    async createGuildCategory(
      botToken,
      guildId,
      input
    ): Promise<DiscordChannel> {
      const response = await postJson(
        `${apiBase}/guilds/${guildId}/channels`,
        `Bot ${botToken}`,
        {
          name: input.name,
          type: CHANNEL_TYPE_GUILD_CATEGORY,
          permission_overwrites: input.permissionOverwrites,
        },
        requestOptions
      )
      if (!response.ok) {
        throw new DiscordRequestError(response.status, response.body)
      }
      return parseChannel(response.body)
    },

    async createGuildChannel(
      botToken,
      guildId,
      input
    ): Promise<DiscordChannel> {
      const response = await postJson(
        `${apiBase}/guilds/${guildId}/channels`,
        `Bot ${botToken}`,
        {
          name: input.name,
          type: CHANNEL_TYPE_GUILD_TEXT,
          parent_id: input.parentId,
          // Omitted entirely, not sent as `[]`, when the caller supplies
          // none — the channel then inherits its category's overwrites
          // through Discord's own permission cascade (this interface's own
          // `createGuildChannel` doc comment), which an explicit empty array
          // achieves the same way, but omitting it keeps the request body
          // matching exactly what the caller actually asked for.
          ...(input.permissionOverwrites
            ? { permission_overwrites: input.permissionOverwrites }
            : {}),
        },
        requestOptions
      )
      if (!response.ok) {
        throw new DiscordRequestError(response.status, response.body)
      }
      return parseChannel(response.body)
    },
  }
}
