/**
 * Google ID token verification (AUTH-2), behind a port.
 *
 * `sign-in.ts` depends only on `GoogleIdTokenVerifier` — the shape below —
 * never on `jose` or a Google SDK directly, the same "the consumer defines
 * the interface, the vendor code implements it" split
 * `docs/ARCHITECTURE.md` describes for `packages/openai`. Tests use a fake
 * verifier (a plain object implementing this interface); this file's own
 * tests exercise `createGoogleIdTokenVerifier` — the real implementation —
 * against a loopback fake server, never Google itself.
 *
 * Signature verification is done by `jose`, not hand-rolled: RSA/JWT
 * verification is exactly the kind of code where a subtle mistake (skipping
 * `alg` confirmation, accepting `none`, a timing side-channel in a
 * hand-written comparison) is a security defect, not a bug, and `jose` is a
 * widely-used, actively maintained implementation with no other dependency
 * of its own. See docs/DECISIONS.md.
 */

import {
  createRemoteJWKSet,
  customFetch,
  errors as joseErrors,
  jwtVerify,
  type FetchImplementation,
  type RemoteJWKSet,
  type RemoteJWKSetOptions,
} from 'jose'

import { CONFIG } from '@bloombot/config'

import type { GoogleIdentity } from './link.js'

export type GoogleIdTokenVerificationResult =
  { ok: true; identity: GoogleIdentity } | { ok: false; reason: string }

/** The port `sign-in.ts` depends on. Implement this to verify a Google ID token, or fake it in a test. */
export interface GoogleIdTokenVerifier {
  verifyIdToken(idToken: string): Promise<GoogleIdTokenVerificationResult>
}

export interface CreateGoogleIdTokenVerifierOptions {
  /** OIDC issuer to trust and to discover keys from. Defaults to `CONFIG.GOOGLE_ISSUER`. */
  issuer?: string
  /** Expected `aud` claim. Defaults to `CONFIG.GOOGLE_CLIENT_ID`. */
  audience?: string
  /** Injectable so tests point discovery and key fetches at a loopback fake instead of the network. Defaults to the global `fetch`. */
  fetchFn?: typeof fetch
  /**
   * Passed straight through to `jose`'s `createRemoteJWKSet` — the only
   * caller that needs this is `google.test.ts`, to shrink `cooldownDuration`
   * so a test can prove a rotated key is picked up without a real 30-second
   * wait (finding 6 of the AUTH-1..4 rework). Production takes `jose`'s own
   * defaults.
   */
  jwksOptions?: RemoteJWKSetOptions
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

interface OidcDiscoveryDocument {
  jwks_uri?: string
}

/**
 * Resolve the issuer's current JWKS *location* via OIDC discovery
 * (`${issuer}/.well-known/openid-configuration`, then whatever `jwks_uri` it
 * names) rather than a hardcoded path — the real Google issuer
 * (`https://accounts.google.com`) does not itself serve keys; discovery is
 * what points at the host that does
 * (`https://www.googleapis.com/oauth2/v3/certs` today), and it is what lets
 * a test's loopback fake serve both documents from one server without this
 * file knowing the real shape of Google's own hosting. Only the *location*
 * — fetching and caching the keys themselves is `createRemoteJWKSet`'s job
 * (below), not this function's.
 */
async function discoverJwksUri(
  issuer: string,
  fetchFn: typeof fetch
): Promise<string> {
  const discoveryResponse = await fetchFn(
    `${stripTrailingSlash(issuer)}/.well-known/openid-configuration`
  )
  if (!discoveryResponse.ok) {
    throw new Error(
      `Google discovery document request failed with status ${discoveryResponse.status}`
    )
  }
  const discovery = (await discoveryResponse.json()) as OidcDiscoveryDocument
  if (!discovery.jwks_uri) {
    throw new Error('Google discovery document is missing jwks_uri')
  }
  return discovery.jwks_uri
}

/**
 * Build a verifier against the real Google issuer (or a fake standing in
 * for it in a test — `options.issuer`/`options.fetchFn`).
 *
 * The JWKS *location* is resolved once, on the first `verifyIdToken` call,
 * and reused for the lifetime of the returned verifier — Google's own
 * `jwks_uri` is stable in practice. The keys served from that location are
 * a different story (finding 6 of the AUTH-1..4 rework): Google rotates its
 * signing keys, and a verifier that fetched them once and cached them
 * forever would start refusing *every* Google sign-in after a rotation,
 * until the process restarted. `jose`'s `createRemoteJWKSet` is used
 * instead of a one-shot fetch precisely because it already does the right
 * thing here — it caches the key set, refetches it when a token's `kid`
 * is not among the cached keys (bounded by its own cooldown, so a flood of
 * tokens with a bogus `kid` cannot turn into a flood of requests to
 * Google), and refetches on a `cacheMaxAge` timer regardless.
 */
export function createGoogleIdTokenVerifier(
  options: CreateGoogleIdTokenVerifierOptions = {}
): GoogleIdTokenVerifier {
  const issuer = options.issuer ?? CONFIG.GOOGLE_ISSUER
  const audience = options.audience ?? CONFIG.GOOGLE_CLIENT_ID
  const fetchFn = options.fetchFn ?? fetch

  let jwks: RemoteJWKSet | undefined

  async function getJwks(): Promise<RemoteJWKSet> {
    if (!jwks) {
      const jwksUri = await discoverJwksUri(issuer, fetchFn)
      jwks = createRemoteJWKSet(new URL(jwksUri), {
        ...options.jwksOptions,
        // `fetchFn` (default: the global `fetch`) is the same injection
        // point discovery uses, so a test pointed at the loopback fake
        // reaches it for key fetches too, not just the discovery document.
        [customFetch]: fetchFn as unknown as FetchImplementation,
      })
    }
    return jwks
  }

  return {
    async verifyIdToken(
      idToken: string
    ): Promise<GoogleIdTokenVerificationResult> {
      // AUTH-2 / AUTH-4's own reasoning applied here too: an unset audience
      // must refuse every token, never silently accept whichever `aud` the
      // token happens to carry.
      if (!audience) {
        return { ok: false, reason: 'no Google client id configured' }
      }

      try {
        const keySet = await getJwks()
        // `jwtVerify` checks the signature against `keySet`, and — because
        // they are passed here rather than checked by hand afterward — the
        // issuer and audience too (AUTH-2: "the issuer and audience
        // checked"), plus standard expiry/not-before claims.
        const { payload } = await jwtVerify(idToken, keySet, {
          issuer,
          audience,
        })

        if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
          return { ok: false, reason: 'ID token is missing its sub claim' }
        }
        if (typeof payload['email'] !== 'string') {
          return { ok: false, reason: 'ID token is missing its email claim' }
        }

        return {
          ok: true,
          identity: {
            subject: payload.sub,
            email: payload['email'],
            // Absent means unverified, not "unknown" — Google always sends
            // this claim for a real account, and treating a missing value
            // as verified would be exactly the takeover AUTH-2 forbids.
            emailVerified: payload['email_verified'] === true,
          },
        }
      } catch (error) {
        return { ok: false, reason: describeVerificationError(error) }
      }
    },
  }
}

/** A short, non-sensitive reason a token failed verification — never the token itself, never a stack trace. */
function describeVerificationError(error: unknown): string {
  if (error instanceof joseErrors.JWTExpired) return 'ID token has expired'
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    return `ID token claim check failed: ${error.claim}`
  }
  if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
    return 'ID token signature is invalid'
  }
  if (error instanceof Error) return error.message
  return 'ID token verification failed'
}
