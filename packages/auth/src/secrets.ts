/**
 * The two operations `tokens.ts` and `sessions.ts` both need on a bearer
 * secret: generate one, and hash one for storage. Kept in one place so the
 * choice is made once rather than twice.
 *
 * `node:crypto`'s CSPRNG, not `Math.random` — the whole point of a sign-in
 * link or a session token is that it cannot be guessed.
 *
 * Hashed with plain SHA-256, not a slow password KDF (bcrypt/scrypt/argon2).
 * A password needs a slow hash because a human-chosen password has low
 * entropy and an attacker with a stolen hash can brute-force it offline; a
 * token generated here has 256 bits of CSPRNG entropy, so brute-forcing a
 * hash of it is infeasible regardless of how fast the hash function is —
 * slowing the hash down would only cost this process CPU on every request
 * for no security benefit. See docs/DECISIONS.md for the fuller version of
 * this argument.
 */

import { createHash, randomBytes } from 'node:crypto'

/** Number of random bytes in a generated secret — 256 bits. */
const SECRET_BYTES = 32

/** A new high-entropy, URL-safe secret. Never store this value; store `hashSecret(secret)` instead. */
export function generateSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url')
}

/** The SHA-256 hash of a secret, hex-encoded, for storage and lookup. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}
