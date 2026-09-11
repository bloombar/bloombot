/**
 * MCP-7: this app's `OAuthServerProvider` — the SDK's own adapter interface
 * (`@modelcontextprotocol/sdk/server/auth/provider.js`) that
 * `mcpAuthRouter` (`server.ts`) dispatches every `/authorize`, `/token` and
 * `/revoke` request to. This is the **second** file in this app allowed to
 * import the vendor SDK (`server.ts`'s own module comment names the
 * original one, for the transport itself) — the same "vendor SDK confined
 * to its own adapter" discipline, held here for the auth subsystem instead:
 * every type and error this file receives from or hands to the SDK is
 * translated at this file's own boundary, and `@bloombot/auth`'s own
 * `mcp-oauth.ts` — the actual business logic and persistence — imports
 * nothing from the SDK at all (that file's own module comment).
 *
 * `clientsStore` never issues a client secret (`@bloombot/db`'s
 * `schema.ts#mcpOauthClients` doc comment has the mechanical reason: the
 * SDK's own `authenticateClient` middleware needs a plaintext secret to
 * compare against, which this platform's "hash every secret at rest"
 * cannot survive at that one call site) — every registered client is
 * public, PKCE-only, `token_endpoint_auth_method: 'none'`, regardless of
 * what a registration request asked for.
 */

import type { Response } from 'express'

import {
  beginAuthorization,
  exchangeAuthorizationCode as authExchangeAuthorizationCode,
  exchangeRefreshToken as authExchangeRefreshToken,
  getOauthClient,
  McpOauthError,
  peekAuthorizationCodeChallenge,
  registerOauthClient,
  revokeToken as authRevokeToken,
  verifyAccessToken as authVerifyAccessToken,
} from '@bloombot/auth'
import type { Database } from '@bloombot/db'

import {
  InvalidGrantError,
  InvalidTargetError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

/** Always `'none'` — this file's own module comment. */
function toSdkClient(client: {
  id: string
  redirectUris: string[]
  clientName?: string
  scope?: string
  grantTypes?: string[]
}): OAuthClientInformationFull {
  return {
    client_id: client.id,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: 'none',
    ...(client.clientName ? { client_name: client.clientName } : {}),
    ...(client.scope ? { scope: client.scope } : {}),
    ...(client.grantTypes ? { grant_types: client.grantTypes } : {}),
  }
}

function buildClientsStore(db: Database): OAuthRegisteredClientsStore {
  return {
    getClient(clientId) {
      const record = getOauthClient(clientId, db)
      return record ? toSdkClient(record) : undefined
    },
    registerClient(client) {
      const record = registerOauthClient(
        {
          redirectUris: client.redirect_uris,
          ...(client.client_name ? { clientName: client.client_name } : {}),
          ...(client.scope ? { scope: client.scope } : {}),
          ...(client.grant_types ? { grantTypes: client.grant_types } : {}),
        },
        db
      )
      // Public, PKCE-only, regardless of what `client` itself asked for —
      // this file's own module comment. `client_secret`/`client_secret_expires_at`
      // are omitted entirely rather than set `undefined`: the SDK's own
      // `clientInfo = { ...clientMetadata, client_secret, ... }` spread
      // (`register.js`) already produced them as `undefined` for a public
      // client, so returning the same shape back is what a caller expects.
      return {
        ...toSdkClient(record),
        client_id_issued_at: Math.floor(Date.now() / 1000),
      }
    },
  }
}

/** Maps this platform's own `McpOauthError` (`@bloombot/auth`'s own file) to the specific SDK error class its own `code` names — never a bare rethrow, since an unmapped `McpOauthError` would fall through to the SDK's generic 500 `ServerError` instead of the 400 these actually are. */
function mapOauthError(error: unknown): never {
  if (error instanceof McpOauthError) {
    if (error.code === 'invalid_target') {
      throw new InvalidTargetError(error.message)
    }
    throw new InvalidGrantError(error.message)
  }
  throw error
}

export interface McpOauthProviderDependencies {
  db: Database
  /** Where `authorize()` sends the browser to consent — `${CONFIG.PUBLIC_APP_URL}/oauth/mcp/authorize` in production (`apps/api/src/routes/mcp-oauth-consent.ts`, that route's own module comment on why this lives in `apps/api` and not here). */
  consentUrl: string
  /** MCP-7's own resource identifier — this server's own `/mcp` endpoint, publicly reachable. `undefined` skips the RFC 8707 resource check entirely (a deployment that has not set `PUBLIC_MCP_URL` yet, `env.ts`'s own doc comment on why that variable is optional). */
  resource?: string
}

export function buildOauthProvider(
  deps: McpOauthProviderDependencies
): OAuthServerProvider {
  const clientsStore = buildClientsStore(deps.db)

  return {
    clientsStore,

    async authorize(
      client: OAuthClientInformationFull,
      params: AuthorizationParams,
      res: Response
    ): Promise<void> {
      const begun = beginAuthorization(
        {
          clientId: client.client_id,
          redirectUri: params.redirectUri,
          codeChallenge: params.codeChallenge,
          ...(params.state !== undefined ? { state: params.state } : {}),
          ...(params.scopes && params.scopes.length > 0
            ? { scope: params.scopes.join(' ') }
            : {}),
          ...(params.resource ? { resource: params.resource.toString() } : {}),
        },
        deps.db
      )
      const url = new URL(deps.consentUrl)
      url.searchParams.set('request', begun.id)
      res.redirect(302, url.toString())
    },

    async challengeForAuthorizationCode(
      client: OAuthClientInformationFull,
      authorizationCode: string
    ): Promise<string> {
      const challenge = peekAuthorizationCodeChallenge(
        authorizationCode,
        client.client_id,
        deps.db
      )
      if (challenge === undefined) {
        throw new InvalidGrantError(
          'This authorization code is unknown, expired, or already used.'
        )
      }
      return challenge
    },

    async exchangeAuthorizationCode(
      client: OAuthClientInformationFull,
      authorizationCode: string,
      _codeVerifier?: string,
      redirectUri?: string,
      resource?: URL
    ): Promise<OAuthTokens> {
      try {
        const issued = authExchangeAuthorizationCode(
          authorizationCode,
          client.client_id,
          redirectUri,
          resource?.toString(),
          deps.db
        )
        return {
          access_token: issued.accessToken,
          token_type: 'bearer',
          expires_in: issued.expiresInSeconds,
          refresh_token: issued.refreshToken,
          ...(issued.scope ? { scope: issued.scope } : {}),
        }
      } catch (error) {
        mapOauthError(error)
      }
    },

    async exchangeRefreshToken(
      client: OAuthClientInformationFull,
      refreshToken: string,
      _scopes?: string[],
      resource?: URL
    ): Promise<OAuthTokens> {
      try {
        const issued = authExchangeRefreshToken(
          refreshToken,
          client.client_id,
          resource?.toString(),
          deps.db
        )
        return {
          access_token: issued.accessToken,
          token_type: 'bearer',
          expires_in: issued.expiresInSeconds,
          refresh_token: issued.refreshToken,
          ...(issued.scope ? { scope: issued.scope } : {}),
        }
      } catch (error) {
        mapOauthError(error)
      }
    },

    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const verified = authVerifyAccessToken(token, deps.db)
      if (!verified) {
        // The SDK's own `requireBearerAuth`/`bearerAuth.js` maps anything
        // thrown here that is not an `OAuthError` to a generic 500 — this
        // file does not use that middleware directly (`server.ts`'s own
        // module comment on why `/mcp` calls this provider straight, to
        // fall back to the legacy session-token path on a miss), but
        // `verifyAccessToken`'s own contract still expects a rejection, not
        // an `undefined`, for a token that does not verify.
        throw new Error('invalid_token')
      }
      if (
        deps.resource !== undefined &&
        verified.resource !== undefined &&
        verified.resource !== deps.resource
      ) {
        throw new Error('invalid_token')
      }
      return {
        token,
        clientId: verified.clientId,
        scopes: verified.scope ? verified.scope.split(' ') : [],
        expiresAt: verified.expiresAtSeconds,
        ...(verified.resource ? { resource: new URL(verified.resource) } : {}),
        extra: { accountId: verified.accountId },
      }
    },

    async revokeToken(
      client: OAuthClientInformationFull,
      request: OAuthTokenRevocationRequest
    ): Promise<void> {
      authRevokeToken(request.token, client.client_id, deps.db)
    },
  }
}
