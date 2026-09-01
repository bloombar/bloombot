/**
 * `DiscordRestClient` (TEN-4) — the port the install flow depends on, and
 * `createDiscordRestClient`, the real implementation behind it. The three
 * calls TEN-4's own verification needs, and nothing else: exchange an
 * authorization code for a user access token, read that user's own guild
 * list (to check the `MANAGE_GUILD`/owner bit — `permissions.ts`), and read
 * the bot's own guild list (to confirm the bot the exchange just installed
 * is actually a member of the guild being claimed). Every request's base URL
 * comes from `CONFIG.DISCORD_API_BASE`/`CONFIG.DISCORD_OAUTH_BASE` (or an
 * explicit override, for a test) — never a literal in this file, the same
 * `packages/openai`'s own `client.ts` holds itself to (QA-2), proven here by
 * `tests/no-vendor-hostname.test.ts`.
 */

import { CONFIG } from '@bloombot/config'

import { getJson, postForm, type RequestOptions } from './http.js'
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
    this.body = body
  }
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

  async function getGuilds(
    authorization: string
  ): Promise<DiscordGuildSummary[]> {
    const response = await getJson(
      `${apiBase}/users/@me/guilds`,
      authorization,
      requestOptions
    )
    if (!response.ok)
      throw new DiscordRequestError(response.status, response.body)
    return parseGuildList(response.body)
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
  }
}
