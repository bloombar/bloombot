/**
 * LINK-3 — connecting a second surface's proof: a Discord identity proven
 * through OAuth+PKCE state (mirrors `discord-install.test.ts`'s own shape),
 * and an MCP identity proven by possessing a single-use, expiring token.
 * Each test below fails without the code it names; see the report for how
 * each was confirmed.
 */

import { createHash, randomUUID } from 'node:crypto'

import {
  organizations,
  people,
  personLinkChallenges,
  schema,
} from '@bloombot/db'
import type { Database } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import {
  beginDiscordPersonLink,
  completeDiscordPersonLink,
  completeMcpPersonLink,
  consumeDiscordPersonLink,
  consumeMcpPersonLinkToken,
  DEFAULT_PERSON_LINK_TTL_MS,
  issueMcpPersonLinkToken,
} from '../src/person-link.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** One organization and one person to begin a connect attempt against — "the account being connected" (D-28). */
function seedOrgAndPerson(db: Database) {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Org', isPersonal: false },
    db
  )
  const person = people.createPerson(organizationId, {}, db)
  return { organizationId, personId: person.id }
}

describe('beginDiscordPersonLink / consumeDiscordPersonLink', () => {
  it('returns a state and a code challenge, and never stores the state in plaintext', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)

    const begun = beginDiscordPersonLink(organizationId, personId, testDb.db)

    expect(begun.state.length).toBeGreaterThan(20)
    expect(begun.expiresAt).toBeGreaterThan(Date.now())
    const rows = testDb.db.select().from(schema.personLinkChallenges).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.secretHash).not.toBe(begun.state)
    expect(JSON.stringify(rows[0])).not.toContain(begun.state)
  })

  it('the returned codeChallenge is the S256 hash of the stored, plaintext verifier', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)

    const begun = beginDiscordPersonLink(organizationId, personId, testDb.db)

    const row = testDb.db.select().from(schema.personLinkChallenges).get()
    const expectedChallenge = createHash('sha256')
      .update(row?.codeVerifier ?? '')
      .digest('base64url')
    expect(begun.codeChallenge).toBe(expectedChallenge)
  })

  it('defaults to a ten-minute expiry', () => {
    expect(DEFAULT_PERSON_LINK_TTL_MS).toBe(10 * 60 * 1000)
  })

  // Cheap-fix 8 of the TEN-4..6 rework, applied here too — see
  // `@bloombot/db`'s `deleteExpiredChallenges` doc comment.
  it('sweeps every already-expired row before inserting its own — no unbounded growth from abandoned attempts', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    // Two abandoned, already-expired attempts from earlier — written
    // directly through the repo (not `beginDiscordPersonLink`, which would
    // sweep each one before the next existed to be counted).
    const now = Date.now()
    personLinkChallenges.createChallenge(
      {
        organizationId,
        personId,
        surface: 'discord',
        secretHash: 'expired-hash-1',
        codeVerifier: 'verifier-1',
        expiresAt: now - 1,
      },
      testDb.db
    )
    personLinkChallenges.createChallenge(
      {
        organizationId,
        personId,
        surface: 'mcp',
        secretHash: 'expired-hash-2',
        expiresAt: now - 1,
      },
      testDb.db
    )
    expect(
      testDb.db.select().from(schema.personLinkChallenges).all()
    ).toHaveLength(2)

    beginDiscordPersonLink(organizationId, personId, testDb.db)

    const rows = testDb.db.select().from(schema.personLinkChallenges).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.expiresAt).toBeGreaterThan(Date.now())
  })

  // LINK-3: "an identity is never bound on a visit alone" — beginning an
  // attempt writes only a challenge row; nothing about the person changes.
  it('a visit without confirmation binds nothing', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)

    beginDiscordPersonLink(organizationId, personId, testDb.db)

    expect(
      people.resolveIdentity(
        organizationId,
        { surface: 'discord', externalId: 'snowflake-1' },
        testDb.db
      )
    ).toBeUndefined()
    const reread = people.getPerson(organizationId, personId, testDb.db)
    expect(reread?.connectedAt).toBeNull()
  })

  it('cannot be redeemed a second time — a replayed state is refused', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    const begun = beginDiscordPersonLink(organizationId, personId, testDb.db)

    const first = consumeDiscordPersonLink(begun.state, testDb.db)
    const second = consumeDiscordPersonLink(begun.state, testDb.db)

    expect(first).toEqual({
      organizationId,
      personId,
      codeVerifier: expect.any(String),
    })
    expect(second).toBeUndefined()
  })

  it('refuses an expired state', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    const begun = beginDiscordPersonLink(
      organizationId,
      personId,
      testDb.db,
      -1
    )

    expect(consumeDiscordPersonLink(begun.state, testDb.db)).toBeUndefined()
  })
})

describe('completeDiscordPersonLink (LINK-3, LINK-4)', () => {
  it('binds only the snowflake it proved — a never-before-seen identity attaches directly to the survivor', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    const begun = beginDiscordPersonLink(organizationId, personId, testDb.db)

    const result = completeDiscordPersonLink(
      begun.state,
      'snowflake-1',
      testDb.db
    )

    expect(result?.id).toBe(personId)
    expect(
      people.resolveIdentity(
        organizationId,
        { surface: 'discord', externalId: 'snowflake-1' },
        testDb.db
      )?.id
    ).toBe(personId)
    // Only the proved snowflake is bound — a different one is not.
    expect(
      people.resolveIdentity(
        organizationId,
        { surface: 'discord', externalId: 'snowflake-2' },
        testDb.db
      )
    ).toBeUndefined()
  })

  it('merges the existing owner of an already-seen snowflake into the survivor (LINK-4)', () => {
    testDb = createTestDatabase()
    const { organizationId, personId: survivorId } = seedOrgAndPerson(testDb.db)
    const priorOwner = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'discord', externalId: 'snowflake-1' },
      testDb.db
    )
    const begun = beginDiscordPersonLink(organizationId, survivorId, testDb.db)

    const result = completeDiscordPersonLink(
      begun.state,
      'snowflake-1',
      testDb.db
    )

    expect(result?.id).toBe(survivorId)
    const rereadPriorOwner = people.getPerson(
      organizationId,
      priorOwner.id,
      testDb.db
    )
    expect(rereadPriorOwner?.mergedIntoPersonId).toBe(survivorId)
  })

  it('refuses without a redeemed state', () => {
    testDb = createTestDatabase()
    expect(
      completeDiscordPersonLink('made-up-state', 'snowflake-1', testDb.db)
    ).toBeUndefined()
  })
})

describe('issueMcpPersonLinkToken / consumeMcpPersonLinkToken (LINK-3)', () => {
  it('is single-use — a replayed token is refused', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    const issued = issueMcpPersonLinkToken(organizationId, personId, testDb.db)

    const first = consumeMcpPersonLinkToken(issued.token, testDb.db)
    const second = consumeMcpPersonLinkToken(issued.token, testDb.db)

    expect(first).toEqual({ organizationId, personId })
    expect(second).toBeUndefined()
  })

  it('is expiring — refused past its own TTL', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    const issued = issueMcpPersonLinkToken(
      organizationId,
      personId,
      testDb.db,
      -1
    )

    expect(consumeMcpPersonLinkToken(issued.token, testDb.db)).toBeUndefined()
  })

  it('is refused after either being used once or expiring — no oracle telling the two apart', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    const used = issueMcpPersonLinkToken(organizationId, personId, testDb.db)
    consumeMcpPersonLinkToken(used.token, testDb.db)
    const expired = issueMcpPersonLinkToken(
      organizationId,
      personId,
      testDb.db,
      -1
    )

    expect(consumeMcpPersonLinkToken(used.token, testDb.db)).toBeUndefined()
    expect(consumeMcpPersonLinkToken(expired.token, testDb.db)).toBeUndefined()
    expect(consumeMcpPersonLinkToken('never-issued', testDb.db)).toBeUndefined()
  })

  it('never carries a Discord-shaped codeVerifier — an MCP token is a bearer secret, nothing more', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    issueMcpPersonLinkToken(organizationId, personId, testDb.db)

    const row = testDb.db.select().from(schema.personLinkChallenges).get()
    expect(row?.surface).toBe('mcp')
    expect(row?.codeVerifier).toBeNull()
  })
})

describe('completeMcpPersonLink (LINK-3, LINK-4)', () => {
  it('attaches a never-before-seen MCP identity directly to the survivor', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    const issued = issueMcpPersonLinkToken(organizationId, personId, testDb.db)

    const result = completeMcpPersonLink(
      issued.token,
      'mcp-client-1',
      testDb.db
    )

    expect(result?.id).toBe(personId)
    expect(
      people.resolveIdentity(
        organizationId,
        { surface: 'mcp', externalId: 'mcp-client-1' },
        testDb.db
      )?.id
    ).toBe(personId)
  })

  it('refuses a token that was already redeemed', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    const issued = issueMcpPersonLinkToken(organizationId, personId, testDb.db)
    completeMcpPersonLink(issued.token, 'mcp-client-1', testDb.db)

    expect(
      completeMcpPersonLink(issued.token, 'mcp-client-1', testDb.db)
    ).toBeUndefined()
  })
})
