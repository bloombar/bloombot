/**
 * MCP-3's own credential: a bearer token, validated the same way
 * `apps/api`'s own session cookie is.
 */

import { revokeSession } from '@bloombot/auth'
import { afterEach, describe, expect, it } from 'vitest'

import {
  authenticateBearerToken,
  parseBearerToken,
} from '../src/authenticate.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'
import { seedSignedInAccount } from './helpers/seed.js'

describe('parseBearerToken', () => {
  it('reads the token out of an Authorization: Bearer header', () => {
    expect(parseBearerToken('Bearer abc123')).toBe('abc123')
  })

  it('is undefined for a missing header', () => {
    expect(parseBearerToken(undefined)).toBeUndefined()
  })

  it('is undefined for a header using a different scheme', () => {
    expect(parseBearerToken('Basic abc123')).toBeUndefined()
  })
})

describe('authenticateBearerToken (MCP-3)', () => {
  let testDb: TestDatabase

  afterEach(() => {
    testDb.cleanup()
  })

  it('resolves a live session token to the account it belongs to', () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)

    expect(authenticateBearerToken(caller.token, testDb.db)).toBe(
      caller.accountId
    )
  })

  it('is undefined for no token at all', () => {
    testDb = createTestDatabase()
    expect(authenticateBearerToken(undefined, testDb.db)).toBeUndefined()
  })

  it('is undefined for a token that never existed', () => {
    testDb = createTestDatabase()
    expect(
      authenticateBearerToken('not-a-real-token', testDb.db)
    ).toBeUndefined()
  })

  it('is undefined for a revoked token — the same refusal as one that never existed', () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    revokeSession(caller.token, testDb.db)

    expect(authenticateBearerToken(caller.token, testDb.db)).toBeUndefined()
  })
})
