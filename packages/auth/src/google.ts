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
  createLocalJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
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
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

interface OidcDiscoveryDocument {
  jwks_uri?: string
}

/**
 * Resolve the issuer's current JWKS via OIDC discovery
 * (`${issuer}/.well-known/openid-configuration`, then whatever `jwks_uri` it
 * names) rather than a hardcoded path — the real Google issuer
 * (`https://accounts.google.com`) does not itself serve keys; discovery is
 * what points at the host that does
 * (`https://www.googleapis.com/oauth2/v3/certs` today), and it is what lets
 * a test's loopback fake serve both documents from one server without this
 * file knowing the real shape of Google's own hosting.
 */
async function discoverJwks(
  issuer: string,
  fetchFn: typeof fetch
): Promise<JSONWebKeySet> {
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

  const jwksResponse = await fetchFn(discovery.jwks_uri)
  if (!jwksResponse.ok) {
    throw new Error(
      `Google JWKS request failed with status ${jwksResponse.status}`
    )
  }
  return (await jwksResponse.json()) as JSONWebKeySet
}

/**
 * Build a verifier against the real Google issuer (or a fake standing in
 * for it in a test — `options.issuer`/`options.fetchFn`).
 *
 * The key set is fetched once, on the first `verifyIdToken` call, and
 * reused for the lifetime of the returned verifier — a fresh verifier (a
 * fresh key-fetch) per process is expected; nothing here refreshes keys on
 * a timer, since a compromised key's real remedy is Google rotating it, at
 * which point the *next* process restart picks up the new set.
 */
export function createGoogleIdTokenVerifier(
  options: CreateGoogleIdTokenVerifierOptions = {}
): GoogleIdTokenVerifier {
  const issuer = options.issuer ?? CONFIG.GOOGLE_ISSUER
  const audience = options.audience ?? CONFIG.GOOGLE_CLIENT_ID
  const fetchFn = options.fetchFn ?? fetch

  let jwks: ReturnType<typeof createLocalJWKSet> | undefined

  async function getJwks(): Promise<ReturnType<typeof createLocalJWKSet>> {
    jwks ??= createLocalJWKSet(await discoverJwks(issuer, fetchFn))
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
