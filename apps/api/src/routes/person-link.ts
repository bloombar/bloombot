/**
 * LINK-6/7/8: the panel's own connect flow — Discord OAuth (LINK-7) and an
 * MCP token (LINK-8), each previewed before it spends anything (LINK-6).
 * The proof mechanism itself lives in `@bloombot/auth`'s `person-link.ts`
 * ("provides the token mechanism, not the server", that file's own module
 * comment); this router is the server that mechanism was always missing —
 * modelled closely on `discord-servers.ts`'s own install flow, which
 * already does an OAuth+PKCE round trip correctly here, right down to
 * reusing its exact redirect URI (below).
 *
 * **Which organization, and which person.** `beginDiscordPersonLink`/
 * `issueMcpPersonLinkToken` need a survivor `personId` *before* any proof
 * exists — bound at issue, D-35's own reasoning for why getting this
 * backwards is an account takeover. The survivor this router uses is the
 * caller's own web person *in the organization the connect attempt names*
 * (`@bloombot/auth#ensureWebPersonForAccount`, created on demand if this is
 * the caller's first visit to that organization) — not the account's own
 * personal organization `sign-in.ts` already connects one in. A student's
 * Discord identity lives wherever the bot that saw them is bound, almost
 * always an institution's own organization, not the account's personal
 * one `findOrCreateAccountForEmail` mints at sign-in — so proving that
 * identity here, in *that* organization, is what lets `connectOrMerge`
 * (`person-link.ts`) find the roster- or role-admitted person already
 * waiting there and merge into it (LINK-4), rather than attaching a fresh,
 * never-enrolled identity nobody can reach a course through.
 *
 * `:organizationId` is a plain, non-secret identifier here, not something
 * LINK-2 forbids putting in a link: LINK-2's own concern is a *claim
 * token* — a secret the first reader can spend — and an organization id is
 * neither a secret nor by itself an oracle (TEN-5 stays intact: an id this
 * account has no reason to be in still only ever gets an empty, harmless
 * person, never a refusal that discloses whether the id is real). Every
 * route below requires a session first (the same `401` `discord-servers.ts`
 * gives an anonymous caller) and checks the organization actually exists
 * before creating anything (`organizationExists`, below) — the same
 * TEN-5 "foreign and nonexistent answer identically" discipline
 * `routes/chat.ts`'s own WEB-10 rework already applies to this exact shape.
 *
 * **Reusing the install flow's own redirect URI.** LINK-7's OAuth round
 * trip lands back on `${PUBLIC_APP_URL}/discord/callback` — the *same*
 * physical page `discord-servers.ts`'s own install flow already uses,
 * rather than a second path this platform's Discord application would need
 * registering separately. The two flows are told apart client-side (which
 * `sessionStorage` marker `apps/web`'s `DiscordCallback.tsx` finds), not by
 * the URL Discord redirects to — this router never sees a request that did
 * not already carry `code`/`state` it can redeem on its own terms, so which
 * page sent the person to Discord in the first place is irrelevant to it.
 *
 * **Why `/discord/preview` and `/discord/confirm` are two calls, not one.**
 * LINK-6 requires a page that "names the account being connected ... and
 * does nothing until the person says to" — a visit (here, Discord's own
 * redirect back) is not consent. The OAuth code exchange can only run once
 * (Discord's own authorization codes are single-use), so `/discord/preview`
 * spends the code — exchanging it for the real snowflake and previewing
 * what completing would do, `state` still unredeemed — and caches the
 * proved identity in `pendingDiscordIdentities`, keyed on `state` itself
 * (a high-entropy secret already, never logged, never persisted — hashing
 * it a second time here would guard against nothing an in-memory,
 * process-local map does not already rule out). `/discord/confirm` never
 * trusts a client-resupplied identity: it reads the *cached* one back by
 * `state`, the same way `completeDiscordPersonLink` itself only ever trusts
 * what a real proof produced. A client-supplied `discordExternalId` on
 * confirm would reopen exactly the account-takeover shape D-35's own
 * rework closed for the redemption itself — a caller could preview honestly
 * and then confirm an arbitrary victim's snowflake instead.
 */

import { Router, type Request } from 'express'
import { z } from 'zod'

import {
  beginDiscordPersonLink,
  completeDiscordPersonLink,
  completeMcpPersonLink,
  DEFAULT_PERSON_LINK_TTL_MS,
  ensureWebPersonForAccount,
  peekDiscordPersonLinkCodeVerifier,
  previewDiscordPersonLink,
  previewMcpPersonLink,
  type PersonLinkPreview,
} from '@bloombot/auth'
import { organizations, type Database } from '@bloombot/db'
import {
  buildDiscordAuthorizationUrl,
  DiscordRequestError,
  type DiscordRestClient,
} from '@bloombot/discord-rest'
import type { Logger } from '@bloombot/logger'

/** One Discord identity this process has proved (via `/discord/preview`'s own code exchange) but not yet bound — LINK-6's own "waits to be told to proceed" half. Never written to `db`: this is exactly as long-lived as the challenge `state` itself governs, and expires with it. */
export interface PendingDiscordIdentity {
  discordExternalId: string
  discordUsername: string
  expiresAt: number
}

export interface PersonLinkRouterDependencies {
  db: Database
  logger: Logger
  discordRestClient: DiscordRestClient
  discordClientId: string
  /** Must exactly match the install flow's own registered redirect URI — see this file's own module comment on why the two flows share one page. */
  discordRedirectUri: string
  discordOauthBase: string
  /** Injectable so a test can seed or inspect a pending identity directly, the same reason `apps/mcp/src/server.ts`'s own `sessions` map is a parameter rather than a private module-level `Map` — defaults to a fresh one per router. */
  pendingDiscordIdentities?: Map<string, PendingDiscordIdentity>
}

/** LINK-7's own scope — just enough to learn the caller's own snowflake (`/users/@me`), never `bot`/`guilds`: this flow installs nothing and reads no guild list, unlike `discord-servers.ts`'s own install flow, which needs both. */
const CONNECT_DISCORD_SCOPE = 'identify'

const previewCallbackInputSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
})
const confirmDiscordInputSchema = z.object({ state: z.string().min(1) })
const mcpTokenInputSchema = z.object({ token: z.string().min(1) })

/** `req.session.accountId` — the same re-check-rather-than-assert discipline `routes/chat.ts#requireAccountId`'s own doc comment explains (a router-level guard's narrowing does not cross into a separately declared handler). */
function requireAccountId(req: Request): string | undefined {
  return req.session?.accountId
}

/**
 * What a preview response carries back to the browser — `PersonLinkPreview`
 * itself, plus (Discord only) the username LINK-6's own "names ... the
 * identity being attached" needs to actually be readable by a person,
 * rather than a bare snowflake.
 */
interface PreviewResponse {
  preview: PersonLinkPreview
  discordUsername?: string
}

/**
 * Resolves `organizationId`, refusing identically (`undefined`) for a
 * foreign or a nonexistent one (TEN-5) — the same explicit existence check
 * `routes/chat.ts#resolveConnectedCallerPerson`'s own doc comment gives for
 * the identical reason: without it, a nonexistent id would reach
 * `ensureWebPersonForAccount`'s own insert and fail its foreign key with a
 * raw `500`, an oracle every other foreign or absent id in this app does
 * not give.
 */
function organizationExists(organizationId: string, db: Database): boolean {
  return organizations.getOrganizationById(organizationId, db) !== undefined
}

/** Drops every pending identity whose challenge would already have expired — sweep-on-write, the same device `deleteExpiredChallenges`/`deleteExpiredInstallStates` already use in `@bloombot/db`, applied here to a map instead of a table since nothing in this one is persisted. */
function sweepExpiredPendingIdentities(
  pending: Map<string, PendingDiscordIdentity>,
  now: number
): void {
  for (const [state, identity] of pending) {
    if (identity.expiresAt <= now) pending.delete(state)
  }
}

export function buildPersonLinkRouter(
  deps: PersonLinkRouterDependencies
): Router {
  const router = Router({ mergeParams: true })
  const pendingDiscordIdentities =
    deps.pendingDiscordIdentities ?? new Map<string, PendingDiscordIdentity>()

  // API-1's own "no session, no [connect]" — every route below needs an
  // already-authenticated caller; a signed-in web account *is* the proof
  // LINK-3 asks for on this surface (D-37's own reasoning, unchanged here).
  router.use((req, res, next) => {
    if (!req.session) {
      res.status(401).json({ error: 'not_signed_in' })
      return
    }
    next()
  })

  /** LINK-7: begin the Discord OAuth round trip — mints a survivor (this account's own web person in `:organizationId`, created on demand) and the OAuth+PKCE state to bind it to. */
  router.post<{ organizationId: string }>('/discord/begin', (req, res) => {
    const organizationId = req.params.organizationId
    const accountId = requireAccountId(req)
    if (!accountId) {
      res.status(401).json({ error: 'not_signed_in' })
      return
    }
    if (!organizationExists(organizationId, deps.db)) {
      res.status(404).json({ error: 'organization_not_found' })
      return
    }

    const survivor = ensureWebPersonForAccount(
      organizationId,
      accountId,
      deps.db
    )
    const begun = beginDiscordPersonLink(organizationId, survivor.id, deps.db)
    const authorizationUrl = buildDiscordAuthorizationUrl({
      oauthBase: deps.discordOauthBase,
      clientId: deps.discordClientId,
      redirectUri: deps.discordRedirectUri,
      state: begun.state,
      codeChallenge: begun.codeChallenge,
      scope: CONNECT_DISCORD_SCOPE,
    })
    res.status(200).json({ authorizationUrl, expiresAt: begun.expiresAt })
  })

  /**
   * LINK-6/7: spend the OAuth code (once — Discord's own codes are
   * single-use), learn the real snowflake, and preview what confirming
   * would do — without redeeming `state` itself, so the person can still
   * leave without anything having changed (LINK-6's own "a visit is not
   * consent").
   */
  router.post<{ organizationId: string }>(
    '/discord/preview',
    (req, res, next) => {
      const organizationId = req.params.organizationId
      const accountId = requireAccountId(req)
      if (!accountId) {
        res.status(401).json({ error: 'not_signed_in' })
        return
      }
      const parsed = previewCallbackInputSchema.safeParse(req.body)
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: 'invalid_request', issues: parsed.error.issues })
        return
      }
      if (!organizationExists(organizationId, deps.db)) {
        res.status(404).json({ error: 'organization_not_found' })
        return
      }
      const survivor = ensureWebPersonForAccount(
        organizationId,
        accountId,
        deps.db
      )

      previewDiscordConnect({
        organizationId,
        survivorPersonId: survivor.id,
        code: parsed.data.code,
        state: parsed.data.state,
        deps,
        pendingDiscordIdentities,
      })
        .then((response) => {
          if (!response) {
            res.status(404).json({ error: 'person_link_not_found' })
            return
          }
          res.status(200).json(response)
        })
        .catch(next)
    }
  )

  /** LINK-7: redeem `state`, attaching or merging (LINK-4) the identity `/discord/preview` already proved and cached — never a client-resupplied one, this file's own module comment on why. */
  router.post<{ organizationId: string }>('/discord/confirm', (req, res) => {
    const organizationId = req.params.organizationId
    const accountId = requireAccountId(req)
    if (!accountId) {
      res.status(401).json({ error: 'not_signed_in' })
      return
    }
    const parsed = confirmDiscordInputSchema.safeParse(req.body)
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'invalid_request', issues: parsed.error.issues })
      return
    }
    const { state } = parsed.data
    sweepExpiredPendingIdentities(pendingDiscordIdentities, Date.now())
    const pending = pendingDiscordIdentities.get(state)
    if (!pending) {
      res.status(404).json({ error: 'person_link_not_found' })
      return
    }
    const survivor = ensureWebPersonForAccount(
      organizationId,
      accountId,
      deps.db
    )
    const result = completeDiscordPersonLink(
      state,
      pending.discordExternalId,
      survivor.id,
      deps.db
    )
    // Spent either way — a `state` that named a different survivor, or
    // whose identity has since been claimed by someone else, is not worth
    // retrying (the same "consumed on a mismatch" rule
    // `completeDiscordPersonLink` itself already follows).
    pendingDiscordIdentities.delete(state)
    if (!result) {
      res.status(404).json({ error: 'person_link_not_found' })
      return
    }
    res.status(200).json({ connected: true })
  })

  /** LINK-6/8: preview what redeeming an MCP-issued token would do — non-consuming, so a person can still change their mind (`previewMcpPersonLink` spends nothing). */
  router.post<{ organizationId: string }>('/mcp/preview', (req, res) => {
    const organizationId = req.params.organizationId
    const accountId = requireAccountId(req)
    if (!accountId) {
      res.status(401).json({ error: 'not_signed_in' })
      return
    }
    const parsed = mcpTokenInputSchema.safeParse(req.body)
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'invalid_request', issues: parsed.error.issues })
      return
    }
    if (!organizationExists(organizationId, deps.db)) {
      res.status(404).json({ error: 'organization_not_found' })
      return
    }
    const survivor = ensureWebPersonForAccount(
      organizationId,
      accountId,
      deps.db
    )
    const preview = previewMcpPersonLink(
      parsed.data.token,
      survivor.id,
      deps.db
    )
    if (!preview) {
      res.status(404).json({ error: 'person_link_not_found' })
      return
    }
    const response: PreviewResponse = { preview }
    res.status(200).json(response)
  })

  /** LINK-8: redeem an MCP-issued token, attaching or merging (LINK-4) the assistant's own identity onto this account's own person in `:organizationId`. */
  router.post<{ organizationId: string }>('/mcp/confirm', (req, res) => {
    const organizationId = req.params.organizationId
    const accountId = requireAccountId(req)
    if (!accountId) {
      res.status(401).json({ error: 'not_signed_in' })
      return
    }
    const parsed = mcpTokenInputSchema.safeParse(req.body)
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'invalid_request', issues: parsed.error.issues })
      return
    }
    if (!organizationExists(organizationId, deps.db)) {
      res.status(404).json({ error: 'organization_not_found' })
      return
    }
    const survivor = ensureWebPersonForAccount(
      organizationId,
      accountId,
      deps.db
    )
    const result = completeMcpPersonLink(
      parsed.data.token,
      survivor.id,
      deps.db
    )
    if (!result) {
      res.status(404).json({ error: 'person_link_not_found' })
      return
    }
    res.status(200).json({ connected: true })
  })

  return router
}

/**
 * `/discord/preview`'s own work, pulled out of the route handler — spends
 * the OAuth code (`exchangeAuthorizationCode` then `getCurrentUser`,
 * exactly the two calls LINK-7's own module comment names), previews the
 * outcome against the real snowflake, and — only once a preview actually
 * resolves — caches it for `/discord/confirm` to redeem later. `undefined`
 * for a `state` that does not preview (unknown, expired, already used, or
 * naming a different survivor — `previewDiscordPersonLink`'s own "no
 * oracle" refusal, LINK-3), the same TEN-5-shaped `404`
 * `previewCallbackInputSchema`'s own caller sends for it. An upstream 4xx
 * from the token exchange (an expired or replayed code) refuses the same
 * way, the same finding 4 of the TEN-4..6 rework `discord-servers.ts#completeInstall`
 * already applies; a genuine transport failure or a 5xx propagates, for
 * `middleware/errors.ts` to turn into an ordinary `500`.
 */
async function previewDiscordConnect(input: {
  organizationId: string
  survivorPersonId: string
  code: string
  state: string
  deps: PersonLinkRouterDependencies
  pendingDiscordIdentities: Map<string, PendingDiscordIdentity>
}): Promise<PreviewResponse | undefined> {
  const { organizationId, survivorPersonId, code, state, deps } = input

  // Read-only — see `peekDiscordPersonLinkCodeVerifier`'s own doc comment
  // for why this cannot be `consumeDiscordPersonLink` itself (that would
  // spend `state` here, in preview, leaving `/discord/confirm` with nothing
  // left to redeem). Also doubles as this route's own "does this state
  // exist and name this survivor" check before an upstream Discord call is
  // ever made — `undefined` for the same reasons `previewDiscordPersonLink`
  // itself refuses.
  const peeked = peekDiscordPersonLinkCodeVerifier(state, deps.db)
  if (!peeked || peeked.personId !== survivorPersonId) return undefined

  let token
  try {
    token = await deps.discordRestClient.exchangeAuthorizationCode({
      code,
      redirectUri: deps.discordRedirectUri,
      codeVerifier: peeked.codeVerifier,
    })
  } catch (error) {
    if (
      error instanceof DiscordRequestError &&
      error.status >= 400 &&
      error.status < 500
    ) {
      deps.logger.warn(
        { organizationId, status: error.status },
        'apps/api: Discord person-link token exchange refused — an expired, replayed, or otherwise invalid authorization code'
      )
      return undefined
    }
    throw error
  }

  const identifiedUser = await deps.discordRestClient.getCurrentUser(
    token.accessToken
  )
  const preview = previewDiscordPersonLink(
    state,
    identifiedUser.id,
    survivorPersonId,
    deps.db
  )
  if (!preview) return undefined

  input.pendingDiscordIdentities.set(state, {
    discordExternalId: identifiedUser.id,
    discordUsername: identifiedUser.username,
    // Matches `DEFAULT_PERSON_LINK_TTL_MS` — this cache entry has no reason
    // to outlive the challenge it is keyed on, and `state` itself already
    // expires on the same schedule.
    expiresAt: Date.now() + DEFAULT_PERSON_LINK_TTL_MS,
  })

  return { preview, discordUsername: identifiedUser.username }
}
