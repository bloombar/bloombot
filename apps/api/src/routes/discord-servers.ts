/**
 * The Discord install flow's two HTTP-shaped steps (TEN-4). Not actions
 * (`@bloombot/actions`' `discord-servers.ts`'s own module comment explains
 * why): both need the caller's own account id — to record as the eventual
 * binding's installer, and to scope the OAuth+PKCE state
 * `@bloombot/auth`'s `discord-install.ts` drives — which nothing in the
 * action-dispatch pipeline carries. Removal (TEN-6) needs neither, so it is
 * `discordServers.remove`, an ordinary action reached through
 * `routes/actions.ts` like any other.
 *
 * Mounted at `/organizations/:organizationId/discord-servers` (`mergeParams`,
 * the same convention `routes/actions.ts` uses), so both routes below
 * resolve the caller's organization the same way that router does: from
 * their own membership, never the request body.
 *
 * A cross-tenant, unauthenticated, or disabled-account request is refused
 * exactly the way `routes/actions.ts` already refuses one for every other
 * action (API-1's own "a route validates nothing, authorizes nothing" —
 * this file inherits that shape rather than inventing a second one): no
 * session is a `401`, and everything else this file refuses — a foreign
 * organization's membership, an unknown/expired/replayed install state, a
 * guild the caller does not administer, a guild the bot was never added to,
 * or a server bound elsewhere already (TEN-3) — is `ActionRefusedError`
 * (`404`, indistinguishable in every case, TEN-5), thrown and handed to
 * `next` so `middleware/errors.ts` is the one place that maps it, same as
 * every action.
 */

import { Router } from 'express'
import { z } from 'zod'

import { ActionRefusedError } from '@bloombot/actions'
import { beginDiscordInstall, consumeDiscordInstallState } from '@bloombot/auth'
import { memberships, discordServers, type Database } from '@bloombot/db'
import {
  administersGuild,
  buildDiscordAuthorizationUrl,
  DiscordRequestError,
  type DiscordRestClient,
} from '@bloombot/discord-rest'
import type { Logger } from '@bloombot/logger'

export interface DiscordServersRouterDependencies {
  db: Database
  /** Finding 4 of the TEN-4..6 rework — where an upstream 4xx from the token exchange is logged, at `warn` rather than `error` (`middleware/errors.ts`'s own unexpected-failure branch is what `error` is reserved for). */
  logger: Logger
  /** The real client in production, a loopback fake in a test — `@bloombot/discord-rest`'s port. */
  discordRestClient: DiscordRestClient
  /** Discord's "client id"/"application id" — `BOT_APP_ID` in env.example. */
  discordClientId: string
  /** The bot's own token — used only for `getBotGuilds`, to confirm the bot the exchange just installed is actually a member of the guild being claimed. Never persisted, never logged. */
  discordBotToken: string
  /** Bot permission integer for the authorize URL's `permissions` param — `BOT_PERMISSIONS` in env.example. Omitted from the URL entirely when unset. */
  discordPermissions?: string
  /** Must exactly match a redirect URI registered with the Discord application — `${publicAppUrl}/discord/callback` in production; a test's own `TEST_PUBLIC_APP_URL` equivalent otherwise. */
  discordRedirectUri: string
  /**
   * The base URL `buildDiscordAuthorizationUrl` builds the authorize URL
   * against — `CONFIG.DISCORD_OAUTH_BASE`, read once in `src/index.ts`
   * alongside every other `CONFIG` value this process reads at startup, and
   * passed in here explicitly. Not defaulted to `CONFIG.DISCORD_OAUTH_BASE`
   * *inside* this file: unlike `src/index.ts`, nothing else in `apps/api`'s
   * request path ever touches `CONFIG` (its own environment is deliberately
   * validated exactly once, at startup — `src/index.ts`'s own API-6
   * comment), and a bare test environment (this package's own test suite
   * never sets `PUBLIC_APP_URL` et al.) has no valid `CONFIG` to fall back
   * on if a request handler reached for it lazily instead.
   */
  discordOauthBase: string
}

const callbackInputSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  guildId: z.string().min(1),
})

/** `:organizationId/discord-servers/install/{begin,callback}` — mounted with `mergeParams`, the same reason `routes/actions.ts` needs it. */
export function buildDiscordServersRouter(
  deps: DiscordServersRouterDependencies
): Router {
  const router = Router({ mergeParams: true })

  /**
   * Begin an installation (TEN-4): generates the OAuth+PKCE state and
   * returns the authorization URL to send the caller's browser to. Requires
   * a signed-in session whose account is a member of `:organizationId` —
   * the same check `routes/actions.ts` runs before it will dispatch
   * anything.
   */
  router.post<{ organizationId: string }>(
    '/install/begin',
    (req, res, next) => {
      if (!req.session) {
        res.status(401).json({ error: 'not_signed_in' })
        return
      }
      const organizationId = req.params['organizationId']
      if (!organizationId) {
        // Unreachable given this router's own route pattern — guarded
        // rather than assumed, the same discipline `routes/actions.ts`
        // takes.
        next(new ActionRefusedError())
        return
      }
      const membership = memberships.getMembership(
        organizationId,
        req.session.accountId,
        deps.db
      )
      if (!membership) {
        next(new ActionRefusedError())
        return
      }

      const begun = beginDiscordInstall(
        organizationId,
        req.session.accountId,
        deps.db
      )
      const authorizationUrl = buildDiscordAuthorizationUrl({
        oauthBase: deps.discordOauthBase,
        clientId: deps.discordClientId,
        redirectUri: deps.discordRedirectUri,
        state: begun.state,
        codeChallenge: begun.codeChallenge,
        ...(deps.discordPermissions
          ? { permissions: deps.discordPermissions }
          : {}),
      })
      res.status(200).json({ authorizationUrl, expiresAt: begun.expiresAt })
    }
  )

  /**
   * Complete an installation (TEN-4): the front end reads `code`/`state`
   * (and, for a `bot`-scope authorization, `guild_id`) off its own
   * callback-page URL — Discord's own redirect target, registered as
   * `deps.discordRedirectUri` — and posts them here, over the session
   * cookie that began the attempt (`SameSite=Lax` survives the top-level
   * navigation through Discord's consent screen and back, D-20).
   */
  router.post<{ organizationId: string }>(
    '/install/callback',
    (req, res, next) => {
      if (!req.session) {
        res.status(401).json({ error: 'not_signed_in' })
        return
      }
      const organizationId = req.params['organizationId']
      if (!organizationId) {
        next(new ActionRefusedError())
        return
      }
      const membership = memberships.getMembership(
        organizationId,
        req.session.accountId,
        deps.db
      )
      if (!membership) {
        next(new ActionRefusedError())
        return
      }

      const parsed = callbackInputSchema.safeParse(req.body)
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: 'invalid_request', issues: parsed.error.issues })
        return
      }
      const { code, state, guildId } = parsed.data

      completeInstall({
        organizationId,
        callerAccountId: req.session.accountId,
        code,
        state,
        guildId,
        deps,
      })
        .then((serverId) => res.status(200).json({ serverId }))
        .catch(next)
    }
  )

  return router
}

/**
 * The callback's actual work, pulled out of the route handler so its
 * control flow (several sequential "refuse the whole thing" checks) reads
 * top to bottom rather than nested inside the handler's own callback chain.
 *
 * Every refusal below — an unknown/replayed/expired state, a state that
 * belongs to a different organization or a different account than the one
 * completing it, an upstream refusal of the code itself, a guild the caller
 * does not administer, a guild the bot is not actually a member of, or a
 * server already actively bound elsewhere (TEN-3) — throws the same
 * `ActionRefusedError` (TEN-5: indistinguishable, and TEN-4's own "tells the
 * caller nothing about who holds it"). A genuine Discord REST failure (a
 * network error, an unexpected non-2xx from a call other than the token
 * exchange) is not caught here — it propagates to the route's own
 * `.catch(next)`, `middleware/errors.ts`'s unexpected-failure branch, and a
 * `500` with no detail in the response.
 */
async function completeInstall(input: {
  organizationId: string
  /** The session that is posting this callback — must be the same account `beginDiscordInstall` issued the state to (finding 1 of the TEN-4..6 rework). */
  callerAccountId: string
  code: string
  state: string
  guildId: string
  deps: DiscordServersRouterDependencies
}): Promise<string> {
  const { organizationId, callerAccountId, code, state, guildId, deps } = input

  const consumed = consumeDiscordInstallState(state, deps.db)
  // Finding 1 of the TEN-4..6 rework: `consumed.accountId` was checked
  // nowhere — a state is scoped to the account that began it as much as to
  // the organization (the row is indexed on both), but only the
  // organization half was ever compared. Without this, `state` leaking as
  // it does — a URL query parameter, so it lands in browser history, a
  // support screenshot, a proxy log — lets any other member of the same
  // organization complete an install *as* the account that began it: the
  // installer recorded at line ~250 below is `consumed.accountId`, not
  // whoever is actually posting this request, so the wrong account's name
  // would end up on the binding while the account that did the work goes
  // unrecorded.
  if (
    !consumed ||
    consumed.organizationId !== organizationId ||
    consumed.accountId !== callerAccountId
  ) {
    throw new ActionRefusedError()
  }

  let token
  try {
    token = await deps.discordRestClient.exchangeAuthorizationCode({
      code,
      redirectUri: deps.discordRedirectUri,
      codeVerifier: consumed.codeVerifier,
    })
  } catch (error) {
    // Finding 4 of the TEN-4..6 rework: an expired or already-redeemed
    // authorization code (Discord's `invalid_grant`, most commonly) is a
    // client-shaped 4xx from the token endpoint, not a genuine Discord REST
    // failure the way a 5xx or a network error is — and every account with
    // a membership can trigger it just by resubmitting a code that already
    // failed. Refused the same way every other rejection in this flow is
    // (TEN-5's own indistinguishable shape) rather than falling through to
    // `middleware/errors.ts`'s unexpected-failure branch, which would 500
    // the caller and write an error-level log line — unbounded, since
    // nothing here throttles a signed-in caller retrying the same request.
    // Logged at `warn`, not `error` (this is an expected, caller-caused
    // outcome), and without `error.body` — `@bloombot/discord-rest`'s own
    // `DiscordRequestError` keeps it out of `.message` for exactly this
    // reason: on a token-exchange failure it can carry the authorization
    // code itself.
    if (
      error instanceof DiscordRequestError &&
      error.status >= 400 &&
      error.status < 500
    ) {
      deps.logger.warn(
        { organizationId, status: error.status },
        'apps/api: Discord token exchange refused — an expired, replayed, or otherwise invalid authorization code'
      )
      throw new ActionRefusedError()
    }
    throw error
  }

  // TEN-4: "verify the installing account actually administers the server
  // ... read from Discord, not from the request" — the user's own guild
  // list, fetched with the access token this exchange just returned, is
  // what is actually read; `guildId` from the request is only ever used to
  // find the matching entry in it, never trusted on its own. This is also
  // the token's only other use: TEN-4's "discards the user access token
  // afterwards ... storing it is a liability" — `token.accessToken` is
  // never read again after this call, never written to `deps.db`, never
  // passed to a logger, and goes out of scope with this function once it
  // returns.
  const userGuilds = await deps.discordRestClient.getUserGuilds(
    token.accessToken
  )
  const guild = userGuilds.find((candidate) => candidate.id === guildId)
  const administers = guild !== undefined && administersGuild(guild)
  if (!administers) {
    throw new ActionRefusedError()
  }

  // Confirms the bot itself is actually a member of the guild being
  // claimed — the exchange above proves the *caller* administers it, not
  // that the bot was actually added during the same consent screen.
  const botGuilds = await deps.discordRestClient.getBotGuilds(
    deps.discordBotToken
  )
  if (!botGuilds.some((guild) => guild.id === guildId)) {
    throw new ActionRefusedError()
  }

  const binding = discordServers.claimDiscordServerBinding(
    organizationId,
    { serverId: guildId, installedByAccountId: consumed.accountId },
    deps.db
  )
  // TEN-3: already actively bound to a different organization — refused the
  // same way, telling the caller nothing about who holds it.
  if (!binding) {
    throw new ActionRefusedError()
  }

  return binding.serverId
}
