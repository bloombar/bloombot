/**
 * Repository for MCP-7's five OAuth 2.1 tables (`schema.ts`'s own module
 * comment on why five, and why none carries `organizationId` — an OAuth
 * connection proves an account, never one organization, the same class
 * `person-link-challenges.ts` already is one layer over). Every function
 * here is keyed on a hash, a client id, or an account id — never scoped to
 * an organization — and is allowlisted in `tests/tenant-scoping-convention.test.ts`
 * for exactly that reason.
 *
 * Hashing happens one layer up, in `@bloombot/auth`'s own `mcp-oauth.ts`
 * (this package's convention: a repo stores whatever hash it is handed, the
 * business logic that generates and hashes a secret lives in `packages/auth`
 * — the same split `person-link-challenges.ts`/`person-link.ts` already
 * hold each other to).
 */

import { and, eq, gt, isNull, lt } from 'drizzle-orm'

import type { Executor } from '../client.js'
import {
  mcpOauthAccessTokens,
  mcpOauthAuthorizationCodes,
  mcpOauthClients,
  mcpOauthPendingAuthorizations,
  mcpOauthRefreshTokens,
} from '../schema.js'

export type McpOauthClient = typeof mcpOauthClients.$inferSelect
export type McpOauthPendingAuthorization =
  typeof mcpOauthPendingAuthorizations.$inferSelect
export type McpOauthAuthorizationCode =
  typeof mcpOauthAuthorizationCodes.$inferSelect
export type McpOauthRefreshToken = typeof mcpOauthRefreshTokens.$inferSelect
export type McpOauthAccessToken = typeof mcpOauthAccessTokens.$inferSelect

// --- Clients ---------------------------------------------------------------

export interface NewMcpOauthClient {
  id: string
  redirectUris: string
  clientName?: string
  scope?: string
  grantTypes?: string
}

/** Registers a client — always `tokenEndpointAuthMethod: 'none'` (`schema.ts`'s own module comment on why no secret is ever stored). */
export function createClient(
  input: NewMcpOauthClient,
  db: Executor
): McpOauthClient {
  return db
    .insert(mcpOauthClients)
    .values({
      id: input.id,
      redirectUris: input.redirectUris,
      clientName: input.clientName ?? null,
      scope: input.scope ?? null,
      grantTypes: input.grantTypes ?? null,
      tokenEndpointAuthMethod: 'none',
      createdAt: Date.now(),
    })
    .returning()
    .get()
}

export function getClient(
  clientId: string,
  db: Executor
): McpOauthClient | undefined {
  return db
    .select()
    .from(mcpOauthClients)
    .where(eq(mcpOauthClients.id, clientId))
    .get()
}

// --- Pending authorizations -------------------------------------------------

export interface NewMcpOauthPendingAuthorization {
  id: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  state?: string
  scope?: string
  resource?: string
  expiresAt: number
}

export function createPendingAuthorization(
  input: NewMcpOauthPendingAuthorization,
  db: Executor
): McpOauthPendingAuthorization {
  return db
    .insert(mcpOauthPendingAuthorizations)
    .values({
      id: input.id,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      state: input.state ?? null,
      scope: input.scope ?? null,
      resource: input.resource ?? null,
      expiresAt: input.expiresAt,
      createdAt: Date.now(),
    })
    .returning()
    .get()
}

/** Read-only — `apps/api`'s consent route reads this to render what is being granted, and again to build the authorization code once a person consents; neither read spends it (there is nothing here to spend — this row is not a credential, `schema.ts`'s own module comment). */
export function getPendingAuthorization(
  id: string,
  now: number,
  db: Executor
): McpOauthPendingAuthorization | undefined {
  return db
    .select()
    .from(mcpOauthPendingAuthorizations)
    .where(
      and(
        eq(mcpOauthPendingAuthorizations.id, id),
        gt(mcpOauthPendingAuthorizations.expiresAt, now)
      )
    )
    .get()
}

export function deletePendingAuthorization(id: string, db: Executor): number {
  const result = db
    .delete(mcpOauthPendingAuthorizations)
    .where(eq(mcpOauthPendingAuthorizations.id, id))
    .run()
  return result.changes
}

export function deleteExpiredPendingAuthorizations(
  now: number,
  db: Executor
): number {
  const result = db
    .delete(mcpOauthPendingAuthorizations)
    .where(lt(mcpOauthPendingAuthorizations.expiresAt, now))
    .run()
  return result.changes
}

// --- Authorization codes -----------------------------------------------------

export interface NewMcpOauthAuthorizationCode {
  id: string
  clientId: string
  codeHash: string
  codeChallenge: string
  redirectUri: string
  scope?: string
  resource?: string
  accountId: string
  expiresAt: number
}

export function createAuthorizationCode(
  input: NewMcpOauthAuthorizationCode,
  db: Executor
): McpOauthAuthorizationCode {
  return db
    .insert(mcpOauthAuthorizationCodes)
    .values({
      id: input.id,
      clientId: input.clientId,
      codeHash: input.codeHash,
      codeChallenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      scope: input.scope ?? null,
      resource: input.resource ?? null,
      accountId: input.accountId,
      expiresAt: input.expiresAt,
      createdAt: Date.now(),
    })
    .returning()
    .get()
}

/** Read-only — the SDK's own `challengeForAuthorizationCode` needs the PKCE challenge *before* it consumes the code (`token.js`'s own two-step "verify, then exchange"), so this must not spend anything. Scoped to `clientId` too — a code presented against a different client than the one it was issued to is not this client's code, the same `surface` filter `person-link-challenges.ts#consumeChallenge`'s own doc comment explains for the identical reason. */
export function peekAuthorizationCode(
  codeHash: string,
  clientId: string,
  now: number,
  db: Executor
): McpOauthAuthorizationCode | undefined {
  return db
    .select()
    .from(mcpOauthAuthorizationCodes)
    .where(
      and(
        eq(mcpOauthAuthorizationCodes.codeHash, codeHash),
        eq(mcpOauthAuthorizationCodes.clientId, clientId),
        isNull(mcpOauthAuthorizationCodes.usedAt),
        gt(mcpOauthAuthorizationCodes.expiresAt, now)
      )
    )
    .get()
}

/** Single-use: one conditional `UPDATE`, the same `consumeChallenge`/`consumeSignInToken` shape every other single-use secret in this platform already uses, so two concurrent redemptions of the same code resolve to exactly one winner. */
export function consumeAuthorizationCode(
  codeHash: string,
  clientId: string,
  now: number,
  db: Executor
): McpOauthAuthorizationCode | undefined {
  return db
    .update(mcpOauthAuthorizationCodes)
    .set({ usedAt: now })
    .where(
      and(
        eq(mcpOauthAuthorizationCodes.codeHash, codeHash),
        eq(mcpOauthAuthorizationCodes.clientId, clientId),
        isNull(mcpOauthAuthorizationCodes.usedAt),
        gt(mcpOauthAuthorizationCodes.expiresAt, now)
      )
    )
    .returning()
    .get()
}

export function deleteExpiredAuthorizationCodes(
  now: number,
  db: Executor
): number {
  const result = db
    .delete(mcpOauthAuthorizationCodes)
    .where(lt(mcpOauthAuthorizationCodes.expiresAt, now))
    .run()
  return result.changes
}

// --- Refresh tokens -----------------------------------------------------------

export interface NewMcpOauthRefreshToken {
  id: string
  clientId: string
  tokenHash: string
  accountId: string
  scope?: string
  resource?: string
  expiresAt: number
}

export function createRefreshToken(
  input: NewMcpOauthRefreshToken,
  db: Executor
): McpOauthRefreshToken {
  return db
    .insert(mcpOauthRefreshTokens)
    .values({
      id: input.id,
      clientId: input.clientId,
      tokenHash: input.tokenHash,
      accountId: input.accountId,
      scope: input.scope ?? null,
      resource: input.resource ?? null,
      expiresAt: input.expiresAt,
      createdAt: Date.now(),
    })
    .returning()
    .get()
}

export function findRefreshTokenByHash(
  tokenHash: string,
  clientId: string,
  now: number,
  db: Executor
): McpOauthRefreshToken | undefined {
  return db
    .select()
    .from(mcpOauthRefreshTokens)
    .where(
      and(
        eq(mcpOauthRefreshTokens.tokenHash, tokenHash),
        eq(mcpOauthRefreshTokens.clientId, clientId),
        isNull(mcpOauthRefreshTokens.usedAt),
        isNull(mcpOauthRefreshTokens.revokedAt),
        gt(mcpOauthRefreshTokens.expiresAt, now)
      )
    )
    .get()
}

/** Rotation's own single-use half (`schema.ts`'s own module comment: a replayed, already-rotated refresh token is detectable because a second exchange finds `usedAt` already set). The caller (`@bloombot/auth`'s `mcp-oauth.ts#exchangeRefreshToken`) inserts the *replacement* refresh token itself, in the same transaction — this function only marks the presented one spent and hands back the row it spent, for that caller to read `accountId`/`scope`/`resource` off of. */
export function consumeRefreshToken(
  tokenHash: string,
  clientId: string,
  now: number,
  db: Executor
): McpOauthRefreshToken | undefined {
  return db
    .update(mcpOauthRefreshTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(mcpOauthRefreshTokens.tokenHash, tokenHash),
        eq(mcpOauthRefreshTokens.clientId, clientId),
        isNull(mcpOauthRefreshTokens.usedAt),
        isNull(mcpOauthRefreshTokens.revokedAt),
        gt(mcpOauthRefreshTokens.expiresAt, now)
      )
    )
    .returning()
    .get()
}

/** `/revoke` — sets `revokedAt`, independent of `usedAt` (`schema.ts`'s own module comment). Idempotent: revoking an already-revoked or already-used token changes nothing further, matching the SDK's own `revokeToken` contract ("if the given token is invalid or already revoked, this method should do nothing"). */
export function revokeRefreshToken(tokenHash: string, db: Executor): void {
  db.update(mcpOauthRefreshTokens)
    .set({ revokedAt: Date.now() })
    .where(
      and(
        eq(mcpOauthRefreshTokens.tokenHash, tokenHash),
        isNull(mcpOauthRefreshTokens.revokedAt)
      )
    )
    .run()
}

export function deleteExpiredRefreshTokens(now: number, db: Executor): number {
  const result = db
    .delete(mcpOauthRefreshTokens)
    .where(lt(mcpOauthRefreshTokens.expiresAt, now))
    .run()
  return result.changes
}

// --- Access tokens -------------------------------------------------------------

export interface NewMcpOauthAccessToken {
  id: string
  clientId: string
  tokenHash: string
  accountId: string
  scope?: string
  resource?: string
  refreshTokenId?: string
  expiresAt: number
}

export function createAccessToken(
  input: NewMcpOauthAccessToken,
  db: Executor
): McpOauthAccessToken {
  return db
    .insert(mcpOauthAccessTokens)
    .values({
      id: input.id,
      clientId: input.clientId,
      tokenHash: input.tokenHash,
      accountId: input.accountId,
      scope: input.scope ?? null,
      resource: input.resource ?? null,
      refreshTokenId: input.refreshTokenId ?? null,
      expiresAt: input.expiresAt,
      createdAt: Date.now(),
    })
    .returning()
    .get()
}

/** `verifyAccessToken`'s own lookup — refuses identically (`undefined`) for a token that never existed, one that has expired, and one that was revoked, the same "no oracle" guarantee every other credential lookup in this platform already gives. */
export function findAccessTokenByHash(
  tokenHash: string,
  now: number,
  db: Executor
): McpOauthAccessToken | undefined {
  return db
    .select()
    .from(mcpOauthAccessTokens)
    .where(
      and(
        eq(mcpOauthAccessTokens.tokenHash, tokenHash),
        isNull(mcpOauthAccessTokens.revokedAt),
        gt(mcpOauthAccessTokens.expiresAt, now)
      )
    )
    .get()
}

export function revokeAccessToken(tokenHash: string, db: Executor): void {
  db.update(mcpOauthAccessTokens)
    .set({ revokedAt: Date.now() })
    .where(
      and(
        eq(mcpOauthAccessTokens.tokenHash, tokenHash),
        isNull(mcpOauthAccessTokens.revokedAt)
      )
    )
    .run()
}

/** `schema.ts`'s own module comment on `refreshTokenId` — revoking or rotating away a refresh token also revokes whichever access token(s) it was issued alongside, so a credential never outlives the refresh token meant to bound its lifetime. */
export function revokeAccessTokensForRefreshToken(
  refreshTokenId: string,
  db: Executor
): void {
  db.update(mcpOauthAccessTokens)
    .set({ revokedAt: Date.now() })
    .where(
      and(
        eq(mcpOauthAccessTokens.refreshTokenId, refreshTokenId),
        isNull(mcpOauthAccessTokens.revokedAt)
      )
    )
    .run()
}

export function deleteExpiredAccessTokens(now: number, db: Executor): number {
  const result = db
    .delete(mcpOauthAccessTokens)
    .where(lt(mcpOauthAccessTokens.expiresAt, now))
    .run()
  return result.changes
}
