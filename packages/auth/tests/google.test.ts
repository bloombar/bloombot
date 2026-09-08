/**
 * AUTH-2 — `createGoogleIdTokenVerifier`, the real implementation, tested
 * against a loopback fake standing in for Google's discovery and JWKS
 * endpoints. No test in this file reaches the network: `issuer` always
 * points at `FakeGoogleServer#baseUrl` (`127.0.0.1`), never at
 * `CONFIG.GOOGLE_ISSUER`'s real default.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createGoogleIdTokenVerifier } from '../src/google.js'
import { FakeGoogleServer } from './helpers/fake-google-server.js'

let server: FakeGoogleServer

beforeEach(async () => {
  server = await FakeGoogleServer.start()
})

afterEach(async () => {
  await server.stop()
})

describe('createGoogleIdTokenVerifier', () => {
  it('verifies a validly signed token and extracts its claims', async () => {
    const verifier = createGoogleIdTokenVerifier({
      issuer: server.baseUrl,
      audience: 'test-client-id',
    })
    const token = await server.signIdToken({
      sub: 'google-subject-1',
      email: 'student@example.edu',
      email_verified: true,
    })

    const result = await verifier.verifyIdToken(token)

    expect(result).toEqual({
      ok: true,
      identity: {
        subject: 'google-subject-1',
        email: 'student@example.edu',
        emailVerified: true,
      },
    })
  })

  // Finding 6 of the AUTH-1..4 rework: Google rotates its signing keys, so
  // a verifier that fetched the JWKS once and cached it for the life of the
  // process would start refusing every Google sign-in the moment the key it
  // cached stops being served — until the process happened to restart.
  // `cooldownDuration: 0` is the only reason this does not need a real
  // 30-second wait: `jose`'s `createRemoteJWKSet` normally refuses to
  // refetch again within its cooldown window even for an unrecognised
  // `kid`, to stop a flood of bad tokens turning into a flood of requests
  // to Google — a real deployment keeps that default; this test shrinks it
  // to prove the refetch itself happens, not to time it.
  it('picks up a rotated signing key without a process restart', async () => {
    const verifier = createGoogleIdTokenVerifier({
      issuer: server.baseUrl,
      audience: 'test-client-id',
      jwksOptions: { cooldownDuration: 0 },
    })
    const tokenBeforeRotation = await server.signIdToken({
      sub: 'google-subject-1',
      email: 'student@example.edu',
      email_verified: true,
    })
    expect((await verifier.verifyIdToken(tokenBeforeRotation)).ok).toBe(true)

    await server.rotateKey()
    const tokenAfterRotation = await server.signIdToken({
      sub: 'google-subject-1',
      email: 'student@example.edu',
      email_verified: true,
    })

    const result = await verifier.verifyIdToken(tokenAfterRotation)

    expect(result).toEqual({
      ok: true,
      identity: {
        subject: 'google-subject-1',
        email: 'student@example.edu',
        emailVerified: true,
      },
    })
  })

  it('surfaces an unverified email as emailVerified: false, never defaulting to true', async () => {
    const verifier = createGoogleIdTokenVerifier({
      issuer: server.baseUrl,
      audience: 'test-client-id',
    })
    const token = await server.signIdToken({
      sub: 'google-subject-1',
      email: 'student@example.edu',
      email_verified: false,
    })

    const result = await verifier.verifyIdToken(token)

    expect(result.ok).toBe(true)
    expect(result.ok && result.identity.emailVerified).toBe(false)
  })

  it('refuses a token signed for a different issuer', async () => {
    const verifier = createGoogleIdTokenVerifier({
      issuer: server.baseUrl,
      audience: 'test-client-id',
    })
    const token = await server.signIdToken(
      {
        sub: 'google-subject-1',
        email: 'student@example.edu',
        email_verified: true,
      },
      { issuer: 'https://not-this-server.example' }
    )

    const result = await verifier.verifyIdToken(token)
    expect(result.ok).toBe(false)
  })

  it('refuses a token issued for a different audience', async () => {
    const verifier = createGoogleIdTokenVerifier({
      issuer: server.baseUrl,
      audience: 'test-client-id',
    })
    const token = await server.signIdToken(
      {
        sub: 'google-subject-1',
        email: 'student@example.edu',
        email_verified: true,
      },
      { audience: 'someone-elses-client-id' }
    )

    const result = await verifier.verifyIdToken(token)
    expect(result.ok).toBe(false)
  })

  it('refuses an expired token', async () => {
    const verifier = createGoogleIdTokenVerifier({
      issuer: server.baseUrl,
      audience: 'test-client-id',
    })
    const token = await server.signIdToken(
      {
        sub: 'google-subject-1',
        email: 'student@example.edu',
        email_verified: true,
      },
      { expiresInSeconds: -60 }
    )

    const result = await verifier.verifyIdToken(token)
    expect(result.ok).toBe(false)
  })

  it('refuses a token whose signature does not match the published key', async () => {
    const verifier = createGoogleIdTokenVerifier({
      issuer: server.baseUrl,
      audience: 'test-client-id',
    })
    const token = await server.signIdToken({
      sub: 'google-subject-1',
      email: 'student@example.edu',
      email_verified: true,
    })
    // Flip one character in the middle of the signature segment — not the
    // last character, whose bits can fall in base64url's unused padding
    // region for a signature length that is not a multiple of three bytes,
    // where a flip can decode back to the same byte and leave the signature
    // untampered.
    const parts = token.split('.')
    const signature = parts[2] ?? ''
    const middle = Math.floor(signature.length / 2)
    const middleChar = signature[middle]
    const tamperedSignature =
      signature.slice(0, middle) +
      (middleChar === 'A' ? 'B' : 'A') +
      signature.slice(middle + 1)
    const tampered = `${parts[0]}.${parts[1]}.${tamperedSignature}`

    const result = await verifier.verifyIdToken(tampered)
    expect(result.ok).toBe(false)
  })

  // AUTH-4's own reasoning applied here: an unset audience must refuse
  // every token rather than silently accept any `aud`.
  it('refuses every token when no client id is configured', async () => {
    const verifier = createGoogleIdTokenVerifier({
      issuer: server.baseUrl,
      audience: '',
    })
    const token = await server.signIdToken({
      sub: 'google-subject-1',
      email: 'student@example.edu',
      email_verified: true,
    })

    const result = await verifier.verifyIdToken(token)
    expect(result).toEqual({
      ok: false,
      reason: 'no Google client id configured',
    })
  })

  it('refuses a token missing its email claim, never defaulting to accepting it', async () => {
    const verifier = createGoogleIdTokenVerifier({
      issuer: server.baseUrl,
      audience: 'test-client-id',
    })
    // A validly signed token that simply carries no `email` claim at all.
    const token = await server.signClaims('google-subject-1', {})

    const result = await verifier.verifyIdToken(token)
    expect(result).toEqual({
      ok: false,
      reason: 'ID token is missing its email claim',
    })
  })

  // The catch-all branch in `describeVerificationError`: a failure that is
  // not one of `jose`'s own claim/signature/expiry errors (here, discovery
  // itself failing against an unreachable loopback address) is still
  // reported as a plain, non-throwing refusal rather than propagating as an
  // unhandled rejection.
  it('reports discovery failure as a refusal, not a thrown error', async () => {
    const verifier = createGoogleIdTokenVerifier({
      // Port 0 is never a real listener; connecting to it fails immediately.
      issuer: 'http://127.0.0.1:0',
      audience: 'test-client-id',
    })
    const token = await server.signIdToken({
      sub: 'google-subject-1',
      email: 'student@example.edu',
      email_verified: true,
    })

    const result = await verifier.verifyIdToken(token)
    expect(result.ok).toBe(false)
  })
})
