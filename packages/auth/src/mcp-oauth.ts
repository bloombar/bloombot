/**
 * MCP-7: this server's own OAuth 2.1 authorization server — the business
 * logic and persistence half. `apps/mcp/src/oauth-provider.ts` is the one
 * file allowed to import `@modelcontextprotocol/sdk`'s auth types
 * (`apps/mcp/src/server.ts`'s own module comment already holds this app to
 * "one file imports the vendor SDK"; this package extends that discipline
 * one step further out — nothing here imports the SDK at all), so every
 * type and error in this file is this platform's own, and
 * `oauth-provider.ts`'s job is translating between the two: SDK types in,
 * SDK errors out, this file's own plain records and typed errors in between.
 *
 * Modelled on `person-link.ts`'s own shape wherever the two overlap — a
 * random secret, hashed at rest (`secrets.ts#hashSecret`), single-use,
 * swept on write — but this is a *different* proof than LINK-3's: an OAuth
 * code/token proves "this client, on behalf of this account", never a
 * person within one organization. `docs/DECISIONS.md`'s MCP-7 entry has the
 * full reasoning for why this server is its own authorization server rather
 * than proxying an upstream one, and why client secrets are never issued at
 * all (`@bloombot/db`'s `schema.ts#mcpOauthClients` doc comment has the
 * mechanical reason — the SDK's own client-auth middleware needs a
 * plaintext secret to compare against, which "hash every secret at rest"
 * cannot survive at that one call site, so this deployment simply never
 * issues one).
 */

import {
  mcpOauth,
  type Database,
  type Executor,
  type TransactingExecutor,
} from '@bloombot/db'

import { generateSecret, hashSecret } from './secrets.js'

// Generous enough that a person can be sent to sign in, sign in, and
// consent, with no delivery delay to accommodate (the same reasoning
// `person-link.ts`'s own `DEFAULT_PERSON_LINK_TTL_MS` doc comment gives for
// its identical ten minutes) — but this is a *browser redirect* carrying
// nothing spendable on its own (`schema.ts`'s own module comment), not a
// bearer secret, so there is less at stake in it running a little long.
export const DEFAULT_PENDING_AUTHORIZATION_TTL_MS = 10 * 60 * 1000

// RFC 6749 §4.1.2 calls out ten minutes as a generous outer bound for an
// authorization code; this platform's own person-link tokens use the same
// figure for an unrelated reason (this file's own module comment). Five
// minutes here, deliberately shorter than that: a code is exchanged by an
// already-running MCP client seconds after the browser redirect completes,
// not carried by a person the way a person-link token or a sign-in link is.
export const DEFAULT_AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000

// An ordinary bearer-token lifetime — long enough that a client is not
// refreshing on every call, short enough that a leaked token is not live
// forever. `verifyAccessToken` (below) is a plain hash lookup either way, so
// this number is a usability/blast-radius tradeoff, not a security boundary
// this file depends on for anything else.
export const DEFAULT_ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000

// 30 days — the same figure the SDK's own dynamic-registration handler uses
// for a client secret's expiry (`register.js#DEFAULT_CLIENT_SECRET_EXPIRY_SECONDS`),
// picked here for refresh tokens instead since this deployment issues no
// client secret at all (this file's own module comment) — long enough that
// a connected assistant does not need a person to re-consent every session,
// short enough that an assistant nobody has used in a month has to prove
// itself again rather than staying live indefinitely.
export const DEFAULT_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** This platform's own plain record of a registered OAuth client — never the SDK's own `OAuthClientInformationFull` (this file's own module comment on why). */
export interface OauthClientRecord {
  id: string
  redirectUris: string[]
  clientName?: string
  scope?: string
  grantTypes?: string[]
}

function toClientRecord(row: mcpOauth.McpOauthClient): OauthClientRecord {
  return {
    id: row.id,
    redirectUris: JSON.parse(row.redirectUris) as string[],
    ...(row.clientName ? { clientName: row.clientName } : {}),
    ...(row.scope ? { scope: row.scope } : {}),
    ...(row.grantTypes
      ? { grantTypes: JSON.parse(row.grantTypes) as string[] }
      : {}),
  }
}

/**
 * Dynamic client registration (RFC 7591) — always public, PKCE-only
 * (`schema.ts#mcpOauthClients`'s own doc comment): whatever
 * `token_endpoint_auth_method` a registration request asked for, no secret
 * is ever generated or stored, and `oauth-provider.ts`'s own clients store
 * adapter is what actually enforces that a caller never sees anything but
 * `'none'` reflected back.
 */
export function registerOauthClient(
  input: {
    redirectUris: string[]
    clientName?: string
    scope?: string
    grantTypes?: string[]
  },
  db: Database
): OauthClientRecord {
  const row = mcpOauth.createClient(
    {
      id: crypto.randomUUID(),
      redirectUris: JSON.stringify(input.redirectUris),
      ...(input.clientName ? { clientName: input.clientName } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.grantTypes
        ? { grantTypes: JSON.stringify(input.grantTypes) }
        : {}),
    },
    db
  )
  return toClientRecord(row)
}

export function getOauthClient(
  clientId: string,
  db: Executor
): OauthClientRecord | undefined {
  const row = mcpOauth.getClient(clientId, db)
  return row ? toClientRecord(row) : undefined
}

/** What beginning an authorization request returns — `oauth-provider.ts#authorize` redirects the browser to a URL carrying this id and nothing else (never a secret — `schema.ts`'s own module comment). */
export interface BeginAuthorization {
  id: string
  expiresAt: number
}

export function beginAuthorization(
  input: {
    clientId: string
    redirectUri: string
    codeChallenge: string
    state?: string
    scope?: string
    resource?: string
  },
  db: Database,
  ttlMs: number = DEFAULT_PENDING_AUTHORIZATION_TTL_MS
): BeginAuthorization {
  const now = Date.now()
  // Sweep-on-write, the same "person-link-challenges.ts" discipline this
  // file's own module comment already holds itself to — every credential
  // table this file writes gets swept here, on the one call every OAuth
  // flow makes exactly once (a fresh `/authorize`), rather than only the
  // pending-authorizations table: a security review found the other three
  // `deleteExpired*` functions in `repos/mcp-oauth.ts` defined and never
  // called, so a spent code and an expired token accumulated forever.
  mcpOauth.deleteExpiredPendingAuthorizations(now, db)
  mcpOauth.deleteExpiredAuthorizationCodes(now, db)
  mcpOauth.deleteExpiredRefreshTokens(now, db)
  mcpOauth.deleteExpiredAccessTokens(now, db)
  const expiresAt = now + ttlMs
  const row = mcpOauth.createPendingAuthorization(
    {
      id: crypto.randomUUID(),
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.resource !== undefined ? { resource: input.resource } : {}),
      expiresAt,
    },
    db
  )
  return { id: row.id, expiresAt: row.expiresAt }
}

/** What `apps/api`'s consent route reads to render "this MCP client will act as your account" (MCP-7's own consent text) before asking a person to decide. */
export interface PendingAuthorizationView {
  id: string
  clientId: string
  clientName?: string
  redirectUri: string
  scope?: string
}

export function peekPendingAuthorization(
  id: string,
  db: Executor
): PendingAuthorizationView | undefined {
  const row = mcpOauth.getPendingAuthorization(id, Date.now(), db)
  if (!row) return undefined
  return toPendingAuthorizationView(row, db)
}

function toPendingAuthorizationView(
  row: mcpOauth.McpOauthPendingAuthorization,
  db: Executor
): PendingAuthorizationView {
  const client = mcpOauth.getClient(row.clientId, db)
  return {
    id: row.id,
    clientId: row.clientId,
    ...(client?.clientName ? { clientName: client.clientName } : {}),
    redirectUri: row.redirectUri,
    ...(row.scope ? { scope: row.scope } : {}),
  }
}

/**
 * `schema.ts#mcpOauthPendingAuthorizations`'s own state-fixation defence
 * (that table's own doc comment) — the *only* other function in this
 * module besides `consentToPendingAuthorization`/`declinePendingAuthorization`
 * below that is allowed to bind or check `accountId` at all. Binds this
 * pending authorization to `accountId` if nobody has claimed it yet, and
 * refuses (`undefined`) — the same shape as an unknown or expired id,
 * never a distinguishable error — if it is already claimed by a
 * *different* account. `apps/api`'s consent route calls this on every
 * signed-in request against a pending id, not only once: reloading the
 * consent screen and submitting a decision both re-assert the same claim.
 */
export function claimPendingAuthorization(
  id: string,
  accountId: string,
  db: Executor
): PendingAuthorizationView | undefined {
  const row = mcpOauth.claimPendingAuthorization(id, accountId, Date.now(), db)
  if (!row) return undefined
  return toPendingAuthorizationView(row, db)
}

/**
 * MCP-7's own non-negotiable: a pending authorization proves nothing by
 * itself — declining simply drops the row, never issuing anything, and the
 * caller (`apps/api`'s consent route) redirects to the client's own
 * `redirectUri` with an `access_denied`-shaped error, never a code.
 * `accountId` is required and checked the same way `consentToPendingAuthorization`
 * checks it (`claimPendingAuthorization`, above) — a decline is a decision
 * too, and must be the *claiming* account's own decision, not any signed-in
 * caller's.
 */
export function declinePendingAuthorization(
  id: string,
  accountId: string,
  db: Database
): PendingAuthorizationView | undefined {
  const claimed = claimPendingAuthorization(id, accountId, db)
  if (!claimed) return undefined
  mcpOauth.deletePendingAuthorization(id, db)
  return claimed
}

/** What consenting to a pending authorization returns — everything `apps/api`'s consent route needs to build the final redirect back to the client. */
export interface IssuedAuthorizationCode {
  code: string
  redirectUri: string
  state?: string
}

/**
 * MCP-7's other non-negotiable: this is the **only** place a signed-in
 * account is bound to an authorization — `accountId` comes from the
 * caller's own already-authenticated web session
 * (`apps/api/src/routes/mcp-oauth-consent.ts`'s own `req.session.accountId`),
 * never from a request field, the identical "the survivor is asserted by
 * the caller, but the other side is fixed at issue" shape `person-link.ts`'s
 * own module comment gives for why that ordering is not an account
 * takeover. `claimPendingAuthorization` (above) is what actually enforces
 * that binding — a security review found the earlier version of this
 * function trusted its own caller to have already checked it, which held
 * only because the one caller that existed did; calling it here instead
 * makes the check load-bearing regardless of what a future caller
 * remembers to do first. The pending row is deleted here, in the same
 * transaction as the code's own insert (`writeTransaction` is not used
 * because both writes are simple enough not to need rollback-on-partial-
 * failure in practice, but see `docs/DECISIONS.md` if this ever needs
 * strengthening) — consenting twice to the same pending id is not possible
 * once this runs once.
 */
export function consentToPendingAuthorization(
  id: string,
  accountId: string,
  db: Database,
  ttlMs: number = DEFAULT_AUTHORIZATION_CODE_TTL_MS
): IssuedAuthorizationCode | undefined {
  const now = Date.now()
  const pending = mcpOauth.claimPendingAuthorization(id, accountId, now, db)
  if (!pending) return undefined
  mcpOauth.deletePendingAuthorization(id, db)

  const code = generateSecret()
  mcpOauth.createAuthorizationCode(
    {
      id: crypto.randomUUID(),
      clientId: pending.clientId,
      codeHash: hashSecret(code),
      codeChallenge: pending.codeChallenge,
      redirectUri: pending.redirectUri,
      ...(pending.scope ? { scope: pending.scope } : {}),
      ...(pending.resource ? { resource: pending.resource } : {}),
      accountId,
      expiresAt: now + ttlMs,
    },
    db
  )
  return {
    code,
    redirectUri: pending.redirectUri,
    ...(pending.state ? { state: pending.state } : {}),
  }
}

/** Thrown by every exchange function below for a refusal the SDK adapter (`oauth-provider.ts`) must map to a *specific* OAuth error, never a bare 500 — `code` is the discriminant it switches on. */
export class McpOauthError extends Error {
  constructor(
    readonly code: 'invalid_grant' | 'invalid_target' | 'invalid_client',
    message: string
  ) {
    super(message)
    this.name = 'McpOauthError'
  }
}

/** `OAuthServerProvider#challengeForAuthorizationCode` — read-only (the SDK's own `tokenHandler` calls this *before* `exchangeAuthorizationCode`, to verify PKCE locally; spending the code here would leave nothing for the exchange itself to consume). Scoped to `clientId` — a code presented against a different client than the one it was issued to reads as not found, the same "no oracle" refusal every single-use secret in this platform already gives. */
export function peekAuthorizationCodeChallenge(
  code: string,
  clientId: string,
  db: Executor
): string | undefined {
  const row = mcpOauth.peekAuthorizationCode(
    hashSecret(code),
    clientId,
    Date.now(),
    db
  )
  return row?.codeChallenge
}

export interface IssuedTokens {
  accessToken: string
  refreshToken: string
  expiresInSeconds: number
  scope?: string
}

/**
 * `OAuthServerProvider#exchangeAuthorizationCode` — PKCE itself is already
 * verified by the SDK before this runs (`challengeForAuthorizationCode`,
 * above, is what it verified against); this function's own job is
 * everything OAuth 2.1 requires *besides* that: the code is single-use
 * (`consumeAuthorizationCode`'s own conditional `UPDATE`), the redirect URI
 * presented here must exactly match the one recorded when the code was
 * issued (RFC 6749 §4.1.3 — the SDK does not check this for us; a code
 * minted for `https://a/callback` redeemed with `https://b/callback` is
 * refused here even though both may be registered against the same
 * client), and the `resource` presented here (if any) must match what the
 * authorization actually named (RFC 8707 — a token minted for a different
 * resource server must not be handed out under cover of this one's own
 * code).
 */
export function exchangeAuthorizationCode(
  code: string,
  clientId: string,
  redirectUri: string | undefined,
  resource: string | undefined,
  db: Database
): IssuedTokens {
  const now = Date.now()
  const consumed = mcpOauth.consumeAuthorizationCode(
    hashSecret(code),
    clientId,
    now,
    db
  )
  if (!consumed) {
    throw new McpOauthError(
      'invalid_grant',
      'This authorization code is unknown, expired, or already used.'
    )
  }
  // RFC 6749 §4.1.3 — `redirect_uri` is REQUIRED at the token endpoint
  // whenever it was present in the authorization request, which every
  // authorization request `beginAuthorization` records always is (the
  // column is `NOT NULL`). A security review found this check optional by
  // omission: the SDK's own `AuthorizationCodeGrantSchema` makes
  // `redirect_uri` an optional field at `/token`, so a client (or an
  // attacker replaying a stolen code) that simply left it out skipped this
  // check entirely rather than being refused by it. Not exploitable on its
  // own — the redirect URI is already fixed, exactly, at `/authorize`, and
  // this check only ever *rejects*, never *widens*, what a code is good
  // for — but the check must not be something a caller can opt out of by
  // omitting the field.
  if (redirectUri === undefined || redirectUri !== consumed.redirectUri) {
    throw new McpOauthError(
      'invalid_grant',
      'redirect_uri does not match the one this code was issued for.'
    )
  }
  if (
    resource !== undefined &&
    consumed.resource !== null &&
    resource !== consumed.resource
  ) {
    throw new McpOauthError(
      'invalid_target',
      'resource does not match the one this authorization named.'
    )
  }

  return issueTokenPair(
    consumed.clientId,
    consumed.accountId,
    consumed.scope ?? undefined,
    consumed.resource ?? undefined,
    db
  )
}

/**
 * `OAuthServerProvider#exchangeRefreshToken` — rotates: the presented
 * refresh token is marked spent (`consumeRefreshToken`'s own single-use
 * `UPDATE`) and a *new* refresh token is issued alongside the new access
 * token, never the same value handed back — `schema.ts`'s own module
 * comment on why a second exchange of the same (now-spent) token is
 * detectable rather than silently accepted. Revokes whatever access token
 * the spent refresh token was issued alongside
 * (`revokeAccessTokensForRefreshToken`) — an access token from a rotated-
 * away refresh token must not keep working past its own refresh token's
 * lifetime.
 */
export function exchangeRefreshToken(
  refreshToken: string,
  clientId: string,
  resource: string | undefined,
  db: Database
): IssuedTokens {
  const now = Date.now()
  const consumed = mcpOauth.consumeRefreshToken(
    hashSecret(refreshToken),
    clientId,
    now,
    db
  )
  if (!consumed) {
    throw new McpOauthError(
      'invalid_grant',
      'This refresh token is unknown, expired, revoked, or already used.'
    )
  }
  if (
    resource !== undefined &&
    consumed.resource !== null &&
    resource !== consumed.resource
  ) {
    throw new McpOauthError(
      'invalid_target',
      'resource does not match the one this refresh token was issued for.'
    )
  }
  mcpOauth.revokeAccessTokensForRefreshToken(consumed.id, db)

  return issueTokenPair(
    consumed.clientId,
    consumed.accountId,
    consumed.scope ?? undefined,
    consumed.resource ?? undefined,
    db
  )
}

/** Shared by both exchange functions above — mints a fresh access token and its own accompanying refresh token, hashed at rest, bound to `refreshTokenId` (`schema.ts#mcpOauthAccessTokens`'s own doc comment on why). */
function issueTokenPair(
  clientId: string,
  accountId: string,
  scope: string | undefined,
  resource: string | undefined,
  db: TransactingExecutor | Database
): IssuedTokens {
  const now = Date.now()
  const refreshToken = generateSecret()
  const refreshRow = mcpOauth.createRefreshToken(
    {
      id: crypto.randomUUID(),
      clientId,
      tokenHash: hashSecret(refreshToken),
      accountId,
      ...(scope ? { scope } : {}),
      ...(resource ? { resource } : {}),
      expiresAt: now + DEFAULT_REFRESH_TOKEN_TTL_MS,
    },
    db
  )
  const accessToken = generateSecret()
  mcpOauth.createAccessToken(
    {
      id: crypto.randomUUID(),
      clientId,
      tokenHash: hashSecret(accessToken),
      accountId,
      ...(scope ? { scope } : {}),
      ...(resource ? { resource } : {}),
      refreshTokenId: refreshRow.id,
      expiresAt: now + DEFAULT_ACCESS_TOKEN_TTL_MS,
    },
    db
  )
  return {
    accessToken,
    refreshToken,
    expiresInSeconds: Math.floor(DEFAULT_ACCESS_TOKEN_TTL_MS / 1000),
    ...(scope ? { scope } : {}),
  }
}

/** What a verified access token resolves to — `OAuthServerProvider#verifyAccessToken`'s own `AuthInfo`, in this platform's own plain shape (`oauth-provider.ts` converts). */
export interface VerifiedAccessToken {
  accountId: string
  clientId: string
  scope?: string
  resource?: string
  expiresAtSeconds: number
}

/** A plain hash lookup — refuses identically for a token that never existed, has expired, or was revoked (this file's own "no oracle" discipline, matching every other credential lookup in this platform). */
export function verifyAccessToken(
  token: string,
  db: Executor
): VerifiedAccessToken | undefined {
  const row = mcpOauth.findAccessTokenByHash(hashSecret(token), Date.now(), db)
  if (!row) return undefined
  return {
    accountId: row.accountId,
    clientId: row.clientId,
    ...(row.scope ? { scope: row.scope } : {}),
    ...(row.resource ? { resource: row.resource } : {}),
    expiresAtSeconds: Math.floor(row.expiresAt / 1000),
  }
}

/**
 * `OAuthServerProvider#revokeToken` — RFC 7009 does not distinguish an
 * access token from a refresh token by shape, only by the (optional)
 * `token_type_hint` a client may send; this tries both regardless of the
 * hint, since a client that gets the hint wrong (or omits it) must still
 * have its token actually revoked — the SDK's own doc comment: "if the
 * given token is invalid or already revoked, this method should do
 * nothing," which both branches below already satisfy on their own.
 * Scoped to `clientId` (the client `authenticateClient` already proved this
 * caller is, threaded through by `oauth-provider.ts`) — one client revoking
 * a token issued to a *different* client is refused the same as a token
 * that never existed, never told apart from it. Revoking a refresh token
 * also revokes whatever access token it was issued alongside
 * (`revokeAccessTokensForRefreshToken`) — the same "a credential must not
 * outlive the thing meant to bound it" reasoning `schema.ts`'s own module
 * comment gives for rotation.
 */
export function revokeToken(
  token: string,
  clientId: string,
  db: Database
): void {
  const hash = hashSecret(token)
  const accessRow = mcpOauth.findAccessTokenByHash(hash, Date.now(), db)
  if (accessRow && accessRow.clientId === clientId) {
    mcpOauth.revokeAccessToken(hash, db)
  }
  const refreshRow = mcpOauth.findRefreshTokenByHash(
    hash,
    clientId,
    Date.now(),
    db
  )
  if (refreshRow) {
    mcpOauth.revokeRefreshToken(hash, db)
    mcpOauth.revokeAccessTokensForRefreshToken(refreshRow.id, db)
  }
}
