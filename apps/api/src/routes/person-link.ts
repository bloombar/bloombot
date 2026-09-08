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
 * **D-44 rework — a signed-in account must not be able to write into an
 * organization it has proven nothing about.** A first version of this
 * router resolved (or created) the caller's own connected `web` person in
 * `:organizationId` — gated only on `organizationExists` — *before* any
 * Discord or MCP proof existed. A reviewer showed exactly what that meant:
 * `POST .../mcp/preview {"token":"not-a-token"}` created a connected
 * person in an organization the caller had never touched, and
 * `GET .../chat/courses` for that organization went from `404` to
 * `200 {"courses":[]}` — a junk request permanently converting an
 * unrelated route into a tenant-existence oracle, and (worse) granting
 * LINK-1's own gate (`connectedAt`) with no Discord or MCP proof
 * whatsoever. "Require a membership first" is not the fix — a student
 * connecting for the first time legitimately has *no* membership in the
 * institution's own organization; that is the entire point of this flow.
 * The fix is ordering: **nothing is created, and nothing is connected,
 * until organization-specific proof is already in hand.**
 *
 *  - **MCP** already had the proof available for free: an issued token is
 *    itself bound to an organization (`peekMcpPersonLink`, new in
 *    `@bloombot/auth`, a plain read). Both `/mcp/preview` and `/mcp/confirm`
 *    now peek the token *first* — refusing not-found-shaped, no write at
 *    all, when it does not exist or names a different organization than
 *    the URL. (Superseded below, "round two": peeking the *token's* own
 *    organization was not enough — the token itself can be minted for any
 *    organization, on demand, by the caller. This paragraph is kept for the
 *    record of what round one actually fixed, not as a description of what
 *    ships today.)
 *  - **Discord** cannot do the same: `beginDiscordPersonLink` needs a real,
 *    already-persisted `personId` before Discord's OAuth ever starts
 *    (PPL-4's own "survivor bound at issue," unchanged, not this rework's
 *    to revisit). There genuinely is no organization-specific proof to
 *    check before that first write. So `/discord/begin` writes a
 *    *bare* person instead — no identity attached, `connectedAt` left
 *    `null` (`resolveOrCreateBareDiscordSurvivor`, below) — which is
 *    indistinguishable, to every other route in this app, from the
 *    organization not existing at all: `routes/chat.ts` resolves a caller
 *    by `web` identity, this row has none; LINK-1's gate reads
 *    `connectedAt`, this row's is `null`. The row costs a little inert
 *    storage in a foreign organization and nothing else, until Discord's
 *    own OAuth genuinely completes — at which point `/discord/confirm`
 *    attaches the account's own `web` identity too (`attachWebIdentityOrMerge`,
 *    below), *after* the Discord identity already set `connectedAt` for a
 *    real reason.
 *
 * **Session binding lives in-memory now, not only in the database.**
 * `person_link_challenges` (the database table `beginDiscordPersonLink`
 * writes) carries a survivor `personId`, never an `accountId` — there is
 * no column to check "is the caller confirming this the same account that
 * began it" against. Before this rework that check did not exist at all:
 * whichever account happened to resolve the *same* `web`-connected
 * survivor (via `ensureWebPersonForAccount`, called again at `preview`/
 * `confirm`) passed, silently — and because that resolution itself
 * created a person on demand, *any* signed-in account resolved to *some*
 * person, so the check was satisfiable by construction, not enforced.
 * `PendingDiscordConnect` (below) is this router's own in-memory record of
 * which account began a given attempt, and of the OAuth code exchange's own
 * result once `/discord/preview` runs it — process-local state, never
 * persisted to `db`, licensed by PLAT-4 (`docs/SPEC.md`: "Four processes,
 * each single-instance … Never clustered") the same way `apps/mcp/src/server.ts`'s
 * own session map already relies on this process being the only one.
 * `/discord/preview` and `/discord/confirm` both refuse not-found-shaped,
 * before touching the database at all, the moment the caller's own session
 * names a different account than the one recorded at `begin` — closing the
 * account-takeover shape a shared `?code=&state=` URL (browser history, a
 * pasted link) would otherwise open.
 *
 * The residual cost of process-local state, stated plainly: a restart
 * (a deploy, a crash, `pm2`'s own supervision) between `begin` and
 * `confirm` loses this record even though `person_link_challenges` itself
 * is still live in the database — `/discord/preview`/`/discord/confirm`
 * answer `person_link_not_found` for a challenge that has not actually
 * expired, and (for Discord specifically) permanently orphans the bare
 * survivor `begin` already wrote (this file's own module comment on why
 * that row is otherwise harmless). The person following the link simply
 * starts over — LINK-6's own "does nothing until told to" means nothing
 * was bound either way — but the orphaned row is a real, if bounded, cost
 * a deploy mid-flow leaves behind.
 *
 * **A caller-mismatch spends nothing, unlike a genuine redemption.**
 * `completeDiscordPersonLink`'s own "consumed either way" rule exists
 * because a *redeemed* secret proves something regardless of what it is
 * redeemed *against* — replaying it teaches an attacker nothing new. A
 * session mismatch here is a different kind of failure: the state itself
 * was never touched, so the rule does not apply, and applying it anyway
 * would hand a stranger who merely learned a previewed `state` (a URL in
 * browser history, a shared machine) a way to permanently deny the real
 * owner's own connect attempt. This router only calls
 * `completeDiscordPersonLink` — which does consume — once the caller's own
 * session has already matched; a mismatch refuses without ever reaching
 * it, leaving `state` exactly as live as it was.
 *
 * `:organizationId` is a plain, non-secret identifier here, not something
 * LINK-2 forbids putting in a link: LINK-2's own concern is a *claim
 * token* — a secret the first reader can spend — and an organization id is
 * neither a secret nor (this rework's own point) something that grants
 * anything on its own anymore.
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
 * what completing would do, `state` still unredeemed — and records the
 * proved identity on the same `PendingDiscordConnect` entry `begin` already
 * created, for `/discord/confirm` to read back later. `/discord/confirm`
 * never trusts a client-resupplied identity: it reads the recorded one, the
 * same way `completeDiscordPersonLink` itself only ever trusts what a real
 * proof produced. A client-supplied `discordExternalId` on confirm would
 * reopen exactly the account-takeover shape D-35's own rework closed for
 * the redemption itself — a caller could preview honestly and then confirm
 * an arbitrary victim's snowflake instead.
 *
 * **D-44 rework, round two — the write was deferred, not authorized, and a
 * reviewer minted their own proof.** The bare-survivor design above (and
 * `peekMcpPersonLink`'s own read-before-write ordering) closed a *junk*
 * token or code — but an MCP token is not itself organization-specific
 * proof of anything: `apps/mcp`'s own `bloombot_connectAssistant` mints one
 * for any organization id, deliberately, no membership required (that
 * tool's own doc comment). Nothing stopped a caller from minting their
 * *own* token for a victim organization and redeeming it against
 * themselves — the write this file's own first rework deferred, an
 * attacker simply performed themselves, over the real MCP and HTTP
 * surfaces, ending with `connectedAt` set in a tenant they had never
 * touched. The Discord half had the identical shape: a caller with no
 * relationship to an organization can always produce a *genuine* Discord
 * OAuth proof of their own, real, never-before-seen-there snowflake —
 * "organization-specific proof" was never what either surface actually
 * checked; both only ever checked "a proof of *something*."
 *
 * **The actual rule: a caller with no membership in this organization may
 * complete only a `merge` or `already-connected` outcome, never a fresh
 * `attach`.** This is what "organization-specific" has to mean: the
 * identity being proved must already resolve to a person *this
 * organization already admitted* — a roster import or a Discord role,
 * `connectOrMerge`'s own `merge` branch — not a person this router would
 * be minting the first record of. It preserves the real student flow
 * exactly (this file's own acceptance test previews `outcome.kind ===
 * 'merge'`, because a roster-admitted student's Discord identity already
 * belongs to someone) while refusing a caller who merely proved *an*
 * identity, not one this organization has ever admitted. For MCP
 * specifically this is enforced by dropping `ensureWebPersonForAccount`
 * (which creates) from `/mcp/preview`/`/mcp/confirm` entirely, in favor of
 * `people.resolveIdentity` — the same read-only shape `routes/chat.ts`'s
 * own `resolveConnectedCallerPerson` already uses — refusing outright when
 * the account has no existing person here: an MCP connect into an
 * organization the account has never otherwise reached is meaningless
 * regardless (there is no enrolment for an assistant to help with), so
 * there is nothing for this surface to create in the first place. For
 * Discord, which still has to write a bare survivor before OAuth even
 * starts (this comment's own "D-44 rework" section above, unchanged), the
 * gate moves to `/discord/preview`: an `attach` outcome for a caller with
 * no membership is treated as a preview failure — refused before the
 * identity is ever cached for confirm to redeem, the same `404` any other
 * preview refusal already gives (`attachWithoutMembershipIsForbidden`, below).
 */

import { Router, type Request } from 'express'
import { z } from 'zod'

import {
  beginDiscordPersonLink,
  completeDiscordPersonLink,
  completeMcpPersonLink,
  peekDiscordPersonLinkCodeVerifier,
  peekMcpPersonLink,
  previewDiscordPersonLink,
  previewMcpPersonLink,
  type PersonLinkPreview,
} from '@bloombot/auth'
import { memberships, organizations, people, type Database } from '@bloombot/db'
import {
  buildDiscordAuthorizationUrl,
  DiscordRequestError,
  type DiscordRestClient,
} from '@bloombot/discord-rest'
import type { Logger } from '@bloombot/logger'

/**
 * One in-flight Discord connect attempt this process is tracking, from
 * `/discord/begin` through to `/discord/confirm` — this file's own module
 * comment on why the account binding lives here, in memory, rather than in
 * `person_link_challenges`. Never written to `db`.
 */
export interface PendingDiscordConnect {
  /** The account whose session began this attempt — checked against the caller's own session on every later call, never trusted from a request body. */
  accountId: string
  organizationId: string
  /** The bare survivor `beginDiscordPersonLink`'s own challenge is bound to (this file's own module comment on why it starts out bare). */
  survivorPersonId: string
  /** Set once `/discord/preview` has actually exchanged the OAuth code for the real snowflake — `undefined` until then, which is what `/discord/confirm` checks to refuse a confirm with no preceding preview (the code can only be exchanged once, so confirm cannot simply redo it). */
  discordExternalId?: string
  discordUsername?: string
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
  /** Injectable so a test can seed or inspect a pending attempt directly, the same reason `apps/mcp/src/server.ts`'s own `sessions` map is a parameter rather than a private module-level `Map` — defaults to a fresh one per router. */
  pendingDiscordConnects?: Map<string, PendingDiscordConnect>
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
 * the identical reason: without it, a nonexistent id would reach a `people`
 * insert and fail its foreign key with a raw `500`, an oracle every other
 * foreign or absent id in this app does not give.
 */
function organizationExists(organizationId: string, db: Database): boolean {
  return organizations.getOrganizationById(organizationId, db) !== undefined
}

/** Drops every pending attempt whose challenge would already have expired — sweep-on-write, the same device `deleteExpiredChallenges`/`deleteExpiredInstallStates` already use in `@bloombot/db`, applied here to a map instead of a table since nothing in this one is persisted. */
function sweepExpiredPendingConnects(
  pending: Map<string, PendingDiscordConnect>,
  now: number
): void {
  for (const [state, connect] of pending) {
    if (connect.expiresAt <= now) pending.delete(state)
  }
}

/**
 * `/discord/begin`'s own survivor resolution (D-44's rework). Reuses the
 * account's existing survivor in `organizationId` in two cases — a
 * legitimate repeat visit *after* connecting (resolved by `web` identity, a
 * plain read), or a repeat/concurrent `begin()` for an attempt still
 * in-flight (resolved from `pendingDiscordConnects`'s own in-memory record,
 * below) — and only creates a *bare* person — no identity attached,
 * `connectedAt` left `null` — when neither finds one. This file's own
 * module comment has the full reasoning for why a bare person is the safe
 * thing to write before any Discord-specific proof exists.
 *
 * Rework finding — a bare survivor carries no identity, so the `web`-identity
 * lookup alone could never find one: the *first* version of this function's
 * own doc comment claimed a "repeat visit" reuse branch that, for anyone who
 * had not yet completed a connect, could never fire — every `begin()` before
 * completion minted a fresh row, unbounded, for as many times as a caller
 * cared to call it (measured directly: 200 calls, 200 rows, nothing sweeps
 * them). The `pendingDiscordConnects` scan closes that: an attempt still
 * live in this process's own memory for this exact `(accountId,
 * organizationId)` pair reuses its own survivor rather than minting a
 * second one. This bounds growth to roughly one row per account per
 * organization per `DEFAULT_PERSON_LINK_TTL_MS` window, not one row per
 * request — the residual (an account that waits out the TTL between
 * attempts still adds a new bare row each time) is accepted and stated
 * plainly, not solved further: `apps/mcp`'s own session-eviction rework
 * (D-36) bounds a comparable resource the identical way, by TTL, not by
 * eliminating repeat use.
 */
function resolveOrCreateBareDiscordSurvivor(
  organizationId: string,
  accountId: string,
  db: Database,
  pendingDiscordConnects: Map<string, PendingDiscordConnect>
): people.Person {
  const existing = people.resolveIdentity(
    organizationId,
    { surface: 'web', externalId: accountId },
    db
  )
  if (existing) return existing

  for (const connect of pendingDiscordConnects.values()) {
    if (connect.accountId !== accountId) continue
    if (connect.organizationId !== organizationId) continue
    const reused = people.getPerson(
      organizationId,
      connect.survivorPersonId,
      db
    )
    if (reused) return reused
  }

  return people.createPerson(organizationId, {}, db)
}

/**
 * D-44 rework, round two — the rule that closes the self-minted-proof
 * exploit (this file's own module comment): a caller with no membership in
 * `organizationId` may complete only a `merge` or `already-connected`
 * outcome, never a fresh `attach`. `memberships.getMembership` is the same
 * tenancy check `routes/actions.ts`/`routes/discord-servers.ts` already run
 * before dispatching anything for a signed-in account — reused here as the
 * one signal available that distinguishes "staff of this institution,
 * legitimately testing their own connect flow" from "a caller who merely
 * proved an identity nobody here admitted." A student's own real, roster-
 * or role-admitted flow is untouched (`outcome.kind` is always `merge` or
 * `already-connected` for one — this file's own acceptance test asserts
 * exactly that).
 */
function attachWithoutMembershipIsForbidden(
  organizationId: string,
  accountId: string,
  outcomeKind: PersonLinkPreview['outcome']['kind'],
  db: Database
): boolean {
  if (outcomeKind !== 'attach') return false
  return memberships.getMembership(organizationId, accountId, db) === undefined
}

/**
 * `/discord/confirm`'s own last step, once Discord's OAuth has genuinely
 * connected `survivorId` (LINK-1's gate already satisfied by that attach):
 * give the survivor the account's own `web` identity too, so a later
 * web-chat visit (`routes/chat.ts`, which resolves a caller by `web`
 * identity alone) finds the same person. Idempotent — a reused survivor
 * (`resolveOrCreateBareDiscordSurvivor`'s own "existing" branch) already
 * holds it, and `connectIdentity`'s own idempotent branch is a no-op.
 * Falls back to a merge on the one genuine race this can hit: two
 * concurrent `/discord/begin` calls for the same account (a double click,
 * two tabs) each mint their own bare survivor, and both later prove a
 * Discord identity — the second one to reach this line finds the account's
 * `web` identity already claimed by the first, and merges itself into it
 * (LINK-4) rather than leaving a proven-but-unreachable second person
 * behind. The same attach-or-merge shape `@bloombot/auth`'s own
 * `connectOrMerge` already uses, composed here from the same two exported
 * primitives rather than duplicated as a new one.
 */
function attachWebIdentityOrMerge(
  organizationId: string,
  survivorId: string,
  accountId: string,
  db: Database
): void {
  const identity = { surface: 'web' as const, externalId: accountId }
  const attached = people.connectIdentity(
    organizationId,
    survivorId,
    identity,
    db
  )
  if (attached) return
  const existingOwner = people.resolveIdentity(organizationId, identity, db)
  if (!existingOwner || existingOwner.id === survivorId) return
  people.mergePeople(organizationId, existingOwner.id, survivorId, db)
}

export function buildPersonLinkRouter(
  deps: PersonLinkRouterDependencies
): Router {
  const router = Router({ mergeParams: true })
  const pendingDiscordConnects =
    deps.pendingDiscordConnects ?? new Map<string, PendingDiscordConnect>()

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

  /** LINK-7: begin the Discord OAuth round trip — mints a bare survivor and the OAuth+PKCE state to bind it to, and records who began the attempt (`PendingDiscordConnect`) for `/discord/preview`/`/discord/confirm` to check later. */
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

    // Sweeps before the reuse scan below, not only inside preview/confirm —
    // an attempt this scan would otherwise treat as "still live" needs to
    // actually still be live (rework finding, this file's own module
    // comment on `resolveOrCreateBareDiscordSurvivor`).
    sweepExpiredPendingConnects(pendingDiscordConnects, Date.now())
    const survivor = resolveOrCreateBareDiscordSurvivor(
      organizationId,
      accountId,
      deps.db,
      pendingDiscordConnects
    )
    const begun = beginDiscordPersonLink(organizationId, survivor.id, deps.db)
    pendingDiscordConnects.set(begun.state, {
      accountId,
      organizationId,
      survivorPersonId: survivor.id,
      expiresAt: begun.expiresAt,
    })
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

      sweepExpiredPendingConnects(pendingDiscordConnects, Date.now())
      const pending = pendingDiscordConnects.get(parsed.data.state)
      // Refuses identically — this file's own module comment — whether
      // `state` never existed, belongs to a different account, or names a
      // different organization than this request's own URL.
      if (
        !pending ||
        pending.accountId !== accountId ||
        pending.organizationId !== organizationId
      ) {
        res.status(404).json({ error: 'person_link_not_found' })
        return
      }

      previewDiscordConnect({
        state: parsed.data.state,
        code: parsed.data.code,
        pending,
        deps,
      })
        .then((response) => {
          if (!response) {
            res.status(404).json({ error: 'person_link_not_found' })
            return
          }
          pending.discordExternalId = response.discordExternalId
          pending.discordUsername = response.discordUsername
          const body: PreviewResponse = {
            preview: response.preview,
            ...(response.discordUsername
              ? { discordUsername: response.discordUsername }
              : {}),
          }
          res.status(200).json(body)
        })
        .catch(next)
    }
  )

  /** LINK-7: redeem `state`, attaching or merging (LINK-4) the identity `/discord/preview` already proved and recorded — never a client-resupplied one, this file's own module comment on why. */
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
    sweepExpiredPendingConnects(pendingDiscordConnects, Date.now())
    const pending = pendingDiscordConnects.get(state)
    // This file's own module comment — a caller-mismatch spends nothing:
    // refused here, before `completeDiscordPersonLink` (the one call that
    // actually consumes `state`) is ever reached, so a stranger who merely
    // learned a previewed `state` cannot burn the real owner's attempt.
    if (
      !pending ||
      pending.accountId !== accountId ||
      pending.organizationId !== organizationId
    ) {
      res.status(404).json({ error: 'person_link_not_found' })
      return
    }
    // No `organizationExists` check here (rework finding — removed, not
    // merely re-explained): `pending.organizationId` is already a real
    // organization, checked at `/discord/begin`, and the comparison above
    // already refuses any mismatch — this check could never fire false,
    // and a reviewer's own mutation (deleting it) left the whole suite
    // green, confirming it was dead rather than merely provably redundant.
    if (!pending.discordExternalId) {
      // No preceding `/discord/preview` — the OAuth code can only be
      // exchanged once, so this handler has no way to redo it itself.
      res.status(404).json({ error: 'person_link_not_found' })
      return
    }

    const result = completeDiscordPersonLink(
      state,
      pending.discordExternalId,
      pending.survivorPersonId,
      deps.db
    )
    pendingDiscordConnects.delete(state)
    if (!result) {
      res.status(404).json({ error: 'person_link_not_found' })
      return
    }
    // Only now — Discord's own OAuth has genuinely proved this identity,
    // and `connectIdentity` has already set `connectedAt` for that real
    // reason — give the survivor the account's own `web` identity too.
    attachWebIdentityOrMerge(
      organizationId,
      pending.survivorPersonId,
      accountId,
      deps.db
    )
    res.status(200).json({ connected: true })
  })

  /** LINK-6/8: preview what redeeming an MCP-issued token would do — non-consuming, so a person can still change their mind (`previewMcpPersonLink` spends nothing), and no `people` write at all unless the token actually names this organization (`peekMcpPersonLink`, this file's own module comment). */
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
    // No `organizationExists` check here (rework finding — this file's own
    // module comment): checking it separately, before the peek below,
    // answered a nonexistent organization with a *different* error code
    // than a real one the token merely does not name — an oracle by itself.
    // The peek-and-match check alone already refuses both identically:
    // `peeked.organizationId` can never equal an organization id that does
    // not exist, so there is nothing an existence check adds.
    const peeked = peekMcpPersonLink(parsed.data.token, deps.db)
    if (!peeked || peeked.organizationId !== organizationId) {
      res.status(404).json({ error: 'person_link_not_found' })
      return
    }
    // D-44 rework, round two (this file's own module comment) — read-only,
    // never `ensureWebPersonForAccount`: an MCP connect creates nothing.
    // The account must already have a person here — reached only through a
    // prior Discord connect, or genuinely already this organization's own
    // (an instructor's personal-org sign-in, say) — or there is no
    // enrolment for an assistant to reach and nothing to preview.
    const survivor = people.resolveIdentity(
      organizationId,
      { surface: 'web', externalId: accountId },
      deps.db
    )
    if (!survivor) {
      res.status(404).json({ error: 'person_link_not_found' })
      return
    }
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

  /** LINK-8: redeem an MCP-issued token, attaching or merging (LINK-4) the assistant's own identity onto this account's own person in `:organizationId` — the same "prove it names this organization before writing anything" gate `/mcp/preview` uses. */
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
    // No `organizationExists` check — same reasoning as `/mcp/preview`,
    // immediately above it in this file.
    const peeked = peekMcpPersonLink(parsed.data.token, deps.db)
    if (!peeked || peeked.organizationId !== organizationId) {
      res.status(404).json({ error: 'person_link_not_found' })
      return
    }
    // Read-only — same as `/mcp/preview`, this file's own module comment.
    const survivor = people.resolveIdentity(
      organizationId,
      { surface: 'web', externalId: accountId },
      deps.db
    )
    if (!survivor) {
      res.status(404).json({ error: 'person_link_not_found' })
      return
    }
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
 * outcome against the real snowflake. `undefined` for a `state` that does
 * not preview (unknown, expired, already used, or naming a different
 * survivor — `previewDiscordPersonLink`'s own "no oracle" refusal, LINK-3),
 * the same TEN-5-shaped `404` this file's own caller sends for it. An
 * upstream 4xx from the token exchange (an expired or replayed code)
 * refuses the same way, the same finding 4 of the TEN-4..6 rework
 * `discord-servers.ts#completeInstall` already applies; a genuine
 * transport failure or a 5xx propagates, for `middleware/errors.ts` to
 * turn into an ordinary `500`.
 */
async function previewDiscordConnect(input: {
  state: string
  code: string
  pending: PendingDiscordConnect
  deps: PersonLinkRouterDependencies
}): Promise<
  | {
      preview: PersonLinkPreview
      discordExternalId: string
      discordUsername: string
    }
  | undefined
> {
  const { state, code, pending, deps } = input

  // Read-only — see `peekDiscordPersonLinkCodeVerifier`'s own doc comment
  // for why this cannot be `consumeDiscordPersonLink` itself (that would
  // spend `state` here, in preview, leaving `/discord/confirm` with nothing
  // left to redeem). Also a defensive cross-check that the database
  // challenge still agrees with this router's own in-memory record of the
  // survivor it was issued for.
  const peeked = peekDiscordPersonLinkCodeVerifier(state, deps.db)
  if (!peeked || peeked.personId !== pending.survivorPersonId) return undefined

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
        { organizationId: pending.organizationId, status: error.status },
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
    pending.survivorPersonId,
    deps.db
  )
  if (!preview) return undefined

  // D-44 rework, round two — this file's own module comment: a caller with
  // no membership here may only merge into (or already hold) an identity
  // this organization already admitted, never mint a fresh `attach`.
  // Refused as an ordinary preview failure — never cached, so
  // `/discord/confirm`'s own "no preceding preview" check refuses it too —
  // rather than shown and then refused at confirm, which would let this
  // screen promise an outcome it does not actually allow (LINK-6's own
  // "the page names ... whether anything will be merged into it").
  if (
    attachWithoutMembershipIsForbidden(
      pending.organizationId,
      pending.accountId,
      preview.outcome.kind,
      deps.db
    )
  ) {
    return undefined
  }

  return {
    preview,
    discordExternalId: identifiedUser.id,
    discordUsername: identifiedUser.username,
  }
}
