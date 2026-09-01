/**
 * Discord's authorization URL (TEN-4), built as a pure string — no network,
 * so nothing here needs a fake server to test. `@bloombot/auth`'s
 * `discord-install.ts` generates the `state`/`code_challenge` this takes;
 * this file's only job is knowing the query-parameter shape Discord's own
 * `/authorize` endpoint expects, the same "the consumer defines the
 * interface, the vendor code knows the wire shape" split
 * `docs/ARCHITECTURE.md` describes for `packages/openai`.
 */

import { CONFIG } from '@bloombot/config'

export interface BuildDiscordAuthorizationUrlInput {
  /** Defaults to `CONFIG.DISCORD_OAUTH_BASE` (QA-2) — read here, at call time, not at module load (PLAT-5). */
  oauthBase?: string
  /** The Discord application id — `BOT_APP_ID` in env.example; Discord's "client id" and "application id" are the same value. */
  clientId: string
  /** Must exactly match a redirect URI registered with the Discord application. */
  redirectUri: string
  state: string
  /** RFC 7636's S256 challenge of a PKCE verifier — `@bloombot/auth#beginDiscordInstall` computes this; this file never sees the verifier itself. */
  codeChallenge: string
  /**
   * The bot's requested permission integer, as a decimal string —
   * `BOT_PERMISSIONS` in env.example. Omitted entirely (not sent as an empty
   * value) when not configured: Discord falls back to the application's own
   * default permissions in that case, which is a different, meaningful
   * outcome from "request zero permissions".
   */
  permissions?: string
  /**
   * Space-separated OAuth scopes. Defaults to `'bot identify guilds'` — TEN-4's
   * own three needs: `bot` installs the bot itself, `identify` and `guilds`
   * are what let the callback read the installing account's own guild list
   * to verify it actually administers the one being installed into.
   */
  scope?: string
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '')
}

/** Build the URL a signed-in caller is sent to Discord's own consent screen through. */
export function buildDiscordAuthorizationUrl(
  input: BuildDiscordAuthorizationUrlInput
): string {
  const base = input.oauthBase ?? CONFIG.DISCORD_OAUTH_BASE
  const url = new URL(`${stripTrailingSlashes(base)}/authorize`)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('scope', input.scope ?? 'bot identify guilds')
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (input.permissions) {
    url.searchParams.set('permissions', input.permissions)
  }
  return url.toString()
}
