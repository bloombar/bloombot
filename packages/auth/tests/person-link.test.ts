/**
 * LINK-3 — connecting a second surface's proof: a Discord identity proven
 * through OAuth+PKCE state (mirrors `discord-install.test.ts`'s own shape),
 * and an MCP identity proven by possessing a single-use, expiring token.
 * Each test below fails without the code it names; see the report for how
 * each was confirmed.
 *
 * D-35 rework — this file also carries the two account-takeover
 * regressions the rework's finding 3 named: state fixation on the Discord
 * half, and caller-asserted identity on the MCP half. Both are written as
 * "the attack no longer succeeds" tests, not merely "the signature
 * changed".
 */

import { createHash, randomUUID } from 'node:crypto'

import {
  organizations,
  people,
  personLinkChallenges,
  schema,
} from '@bloombot/db'
import type { Database } from '@bloombot/db'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  beginDiscordPersonLink,
  completeDiscordPersonLink,
  completeMcpPersonLink,
  consumeDiscordPersonLink,
  consumeMcpPersonLinkToken,
  DEFAULT_PERSON_LINK_TTL_MS,
  issueMcpPersonLinkToken,
  peekMcpPersonLink,
  previewDiscordPersonLink,
  previewMcpPersonLink,
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
        surface: 'discord',
        personId,
        codeVerifier: 'verifier-1',
        secretHash: 'expired-hash-1',
        expiresAt: now - 1,
      },
      testDb.db
    )
    personLinkChallenges.createChallenge(
      {
        organizationId,
        surface: 'mcp',
        identityExternalId: 'mcp-client-1',
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

  // D-35 rework, finding 6 — a token/state presented to the *wrong*
  // surface's own redemption path must not be burned before being
  // rejected. `consumeMcpPersonLinkToken` shares the same underlying
  // `consumeChallenge`, so exercising it here against a *Discord* state
  // proves the surface filter, not just that mismatched values fail.
  it('a state issued for Discord is refused (not burned) by the MCP redemption path', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    const begun = beginDiscordPersonLink(organizationId, personId, testDb.db)

    const wrongSurface = consumeMcpPersonLinkToken(begun.state, testDb.db)
    expect(wrongSurface).toBeUndefined()

    // Still live for its own, correct surface — the mismatched attempt did
    // not consume it.
    const rightSurface = consumeDiscordPersonLink(begun.state, testDb.db)
    expect(rightSurface).toBeDefined()
  })
})

describe('previewDiscordPersonLink (LINK-3: "the page names the account being connected and waits to be told to proceed")', () => {
  it('reports an attach outcome for a never-before-seen identity, and does not consume the state', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    const begun = beginDiscordPersonLink(organizationId, personId, testDb.db)

    const preview = previewDiscordPersonLink(
      begun.state,
      'snowflake-1',
      personId,
      testDb.db
    )

    expect(preview).toEqual({
      organizationId,
      survivorPersonId: personId,
      identity: { surface: 'discord', externalId: 'snowflake-1' },
      outcome: { kind: 'attach' },
    })
    // Not spent — the real completion afterward still succeeds.
    expect(
      completeDiscordPersonLink(begun.state, 'snowflake-1', personId, testDb.db)
    ).toBeDefined()
  })

  it('reports a merge outcome, naming the person who would be absorbed, when the identity already belongs to someone else', () => {
    testDb = createTestDatabase()
    const { organizationId, personId: survivorId } = seedOrgAndPerson(testDb.db)
    const priorOwner = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'discord', externalId: 'snowflake-1' },
      testDb.db
    )
    const begun = beginDiscordPersonLink(organizationId, survivorId, testDb.db)

    const preview = previewDiscordPersonLink(
      begun.state,
      'snowflake-1',
      survivorId,
      testDb.db
    )

    expect(preview?.outcome).toEqual({
      kind: 'merge',
      existingPersonId: priorOwner.id,
    })
  })

  it('refuses for a state that does not redeem', () => {
    testDb = createTestDatabase()
    expect(
      previewDiscordPersonLink(
        'made-up-state',
        'snowflake-1',
        'some-person-id',
        testDb.db
      )
    ).toBeUndefined()
  })

  // Rework — the fix for the preview-side oracle: a caller who is not the
  // same person `state` was issued to must not be able to learn anything
  // from previewing it, the same "state fixation" check
  // `completeDiscordPersonLink` already applies at redemption. Fails
  // without the `callerPersonId` check (a preview would succeed for anyone
  // who merely knows a valid `state`, regardless of who they are signed in
  // as).
  it('refuses when callerPersonId does not match the survivor the state was issued for — the preview-side state-fixation fix', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    const begun = beginDiscordPersonLink(organizationId, personId, testDb.db)
    const someoneElse = people.createPerson(organizationId, {}, testDb.db)

    const preview = previewDiscordPersonLink(
      begun.state,
      'snowflake-1',
      someoneElse.id,
      testDb.db
    )

    expect(preview).toBeUndefined()
    // Not burned by the mismatched preview — the real survivor can still
    // complete it.
    expect(
      completeDiscordPersonLink(begun.state, 'snowflake-1', personId, testDb.db)
    ).toBeDefined()
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
      personId,
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

  // D-35 rework, finding 1 — completing a connect for an identity nobody
  // has ever seen before must set `connectedAt`, or the person is declined
  // by LINK-1's own gate on their very next message despite having just
  // proven themselves.
  it('sets connectedAt on a successful attach', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    const begun = beginDiscordPersonLink(organizationId, personId, testDb.db)

    completeDiscordPersonLink(begun.state, 'snowflake-1', personId, testDb.db)

    expect(
      people.getPerson(organizationId, personId, testDb.db)?.connectedAt
    ).not.toBeNull()
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
      survivorId,
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
    const { personId } = seedOrgAndPerson(testDb.db)
    expect(
      completeDiscordPersonLink(
        'made-up-state',
        'snowflake-1',
        personId,
        testDb.db
      )
    ).toBeUndefined()
  })

  // D-35 rework, finding 3 — the state-fixation takeover, reproduced and
  // shown fixed. Before this fix, nothing tied the caller *redeeming* a
  // state to the caller who *began* it: an attacker could begin their own
  // attempt (survivor = attacker), hand the resulting authorization URL to
  // a victim, and — the moment the victim approved it on Discord's own
  // consent screen, proving the *victim's real* snowflake — absorb the
  // victim into the attacker's own person. The fix is `callerPersonId`:
  // whoever actually completes this must already be authenticated as the
  // same person the attempt began for.
  it('refuses to complete for a caller who is not the person the attempt began for — the state-fixation takeover', () => {
    testDb = createTestDatabase()
    const { organizationId, personId: attackerId } = seedOrgAndPerson(testDb.db)
    const victim = people.createPerson(organizationId, {}, testDb.db)
    // The attacker begins their own attempt and would, pre-fix, hand this
    // very `state` to the victim as an "authorization link".
    const begun = beginDiscordPersonLink(organizationId, attackerId, testDb.db)

    // The victim's own browser completes the OAuth consent (proving the
    // victim's real snowflake) and calls back into this module — but as
    // the *victim*, not the attacker: `callerPersonId` is the victim's own,
    // established by the victim's own already-authenticated session, never
    // read out of `state` itself.
    const result = completeDiscordPersonLink(
      begun.state,
      'victims-real-snowflake',
      victim.id,
      testDb.db
    )

    expect(result).toBeUndefined()
    // The takeover did not happen: the victim's snowflake was never
    // attached to the attacker, and the victim's own record is untouched.
    expect(
      people.resolveIdentity(
        organizationId,
        { surface: 'discord', externalId: 'victims-real-snowflake' },
        testDb.db
      )
    ).toBeUndefined()
    const rereadVictim = people.getPerson(organizationId, victim.id, testDb.db)
    expect(rereadVictim?.mergedIntoPersonId).toBeNull()
    expect(rereadVictim?.connectedAt).toBeNull()
    const rereadAttacker = people.getPerson(
      organizationId,
      attackerId,
      testDb.db
    )
    expect(rereadAttacker?.connectedAt).toBeNull()
  })

  it('still consumes the state on a caller mismatch — no retry, the same "spent either way" rule every single-use secret in this package follows', () => {
    testDb = createTestDatabase()
    const { organizationId, personId: attackerId } = seedOrgAndPerson(testDb.db)
    const victim = people.createPerson(organizationId, {}, testDb.db)
    const begun = beginDiscordPersonLink(organizationId, attackerId, testDb.db)

    completeDiscordPersonLink(
      begun.state,
      'victims-real-snowflake',
      victim.id,
      testDb.db
    )

    // Not even the legitimate attacker can now use it.
    expect(
      completeDiscordPersonLink(
        begun.state,
        'victims-real-snowflake',
        attackerId,
        testDb.db
      )
    ).toBeUndefined()
  })

  // D-35 rework, finding 7 — redeem-then-attach/merge is one transaction: a
  // failure partway through the attach/merge half must not leave the state
  // consumed with nothing actually connected. Forced the same way
  // `sign-in.test.ts`'s own "a failure creating the account rolls back the
  // organization it already created" forces TEN-1's atomicity: a real
  // primary-key collision, not a monkey-patched transaction — `connectIdentity`'s
  // own `person_identities` insert is the only `crypto.randomUUID()` call
  // in this whole redeem-then-attach sequence, made to collide with an
  // already-committed, unrelated row.
  it('rolls back the consumed state when the attach half fails partway through', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    const begun = beginDiscordPersonLink(organizationId, personId, testDb.db)
    const otherPerson = people.createPerson(organizationId, {}, testDb.db)
    const collidingIdentity = people.connectIdentity(
      organizationId,
      otherPerson.id,
      { surface: 'web', externalId: 'unrelated-account' },
      testDb.db
    )
    if (!collidingIdentity) throw new Error('setup failed')

    const randomUUIDSpy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(
        collidingIdentity.id as `${string}-${string}-${string}-${string}-${string}`
      )

    expect(() =>
      completeDiscordPersonLink(begun.state, 'snowflake-1', personId, testDb.db)
    ).toThrow()
    randomUUIDSpy.mockRestore()

    // The whole transaction rolled back, including the outer consume — the
    // state is still live, not spent on a connection that never happened.
    const stillLive = previewDiscordPersonLink(
      begun.state,
      'snowflake-1',
      personId,
      testDb.db
    )
    expect(stillLive?.outcome).toEqual({ kind: 'attach' })
    expect(
      people.resolveIdentity(
        organizationId,
        { surface: 'discord', externalId: 'snowflake-1' },
        testDb.db
      )
    ).toBeUndefined()
  })
})

describe('issueMcpPersonLinkToken / consumeMcpPersonLinkToken (LINK-3)', () => {
  it('is bound to the identity at issue, not a survivor (D-35 rework, finding 3)', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgAndPerson(testDb.db)

    issueMcpPersonLinkToken(organizationId, 'mcp-client-1', testDb.db)

    const row = testDb.db.select().from(schema.personLinkChallenges).get()
    expect(row?.identityExternalId).toBe('mcp-client-1')
    expect(row?.personId).toBeNull()
  })

  it('is single-use — a replayed token is refused', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgAndPerson(testDb.db)
    const issued = issueMcpPersonLinkToken(
      organizationId,
      'mcp-client-1',
      testDb.db
    )

    const first = consumeMcpPersonLinkToken(issued.token, testDb.db)
    const second = consumeMcpPersonLinkToken(issued.token, testDb.db)

    expect(first).toEqual({
      organizationId,
      identity: { surface: 'mcp', externalId: 'mcp-client-1' },
    })
    expect(second).toBeUndefined()
  })

  it('is expiring — refused past its own TTL', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgAndPerson(testDb.db)
    const issued = issueMcpPersonLinkToken(
      organizationId,
      'mcp-client-1',
      testDb.db,
      -1
    )

    expect(consumeMcpPersonLinkToken(issued.token, testDb.db)).toBeUndefined()
  })

  it('is refused after either being used once or expiring — no oracle telling the two apart', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgAndPerson(testDb.db)
    const used = issueMcpPersonLinkToken(
      organizationId,
      'mcp-client-1',
      testDb.db
    )
    consumeMcpPersonLinkToken(used.token, testDb.db)
    const expired = issueMcpPersonLinkToken(
      organizationId,
      'mcp-client-2',
      testDb.db,
      -1
    )

    expect(consumeMcpPersonLinkToken(used.token, testDb.db)).toBeUndefined()
    expect(consumeMcpPersonLinkToken(expired.token, testDb.db)).toBeUndefined()
    expect(consumeMcpPersonLinkToken('never-issued', testDb.db)).toBeUndefined()
  })

  it('never carries a Discord-shaped codeVerifier — an MCP token is a bearer secret, nothing more', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgAndPerson(testDb.db)
    issueMcpPersonLinkToken(organizationId, 'mcp-client-1', testDb.db)

    const row = testDb.db.select().from(schema.personLinkChallenges).get()
    expect(row?.surface).toBe('mcp')
    expect(row?.codeVerifier).toBeNull()
  })
})

describe("peekMcpPersonLink — checking a token's own organization with no survivor involved", () => {
  it('reports the organization and identity a live token belongs to', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgAndPerson(testDb.db)
    const issued = issueMcpPersonLinkToken(
      organizationId,
      'mcp-client-1',
      testDb.db
    )

    const peeked = peekMcpPersonLink(issued.token, testDb.db)

    expect(peeked).toEqual({
      organizationId,
      identity: { surface: 'mcp', externalId: 'mcp-client-1' },
    })
  })

  it('does not consume the token — a real preview afterward still succeeds', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    const issued = issueMcpPersonLinkToken(
      organizationId,
      'mcp-client-1',
      testDb.db
    )

    peekMcpPersonLink(issued.token, testDb.db)

    expect(
      previewMcpPersonLink(issued.token, personId, testDb.db)
    ).toBeDefined()
  })

  it('refuses for a token that was never issued, is expired, or was issued for the other surface', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)

    expect(peekMcpPersonLink('never-issued', testDb.db)).toBeUndefined()

    const expired = issueMcpPersonLinkToken(
      organizationId,
      'mcp-client-1',
      testDb.db,
      -1
    )
    expect(peekMcpPersonLink(expired.token, testDb.db)).toBeUndefined()

    const begun = beginDiscordPersonLink(organizationId, personId, testDb.db)
    expect(peekMcpPersonLink(begun.state, testDb.db)).toBeUndefined()
  })
})

describe('previewMcpPersonLink', () => {
  it('reports an attach outcome for a never-before-seen identity, and does not consume the token', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    const issued = issueMcpPersonLinkToken(
      organizationId,
      'mcp-client-1',
      testDb.db
    )

    const preview = previewMcpPersonLink(issued.token, personId, testDb.db)

    expect(preview).toEqual({
      organizationId,
      survivorPersonId: personId,
      identity: { surface: 'mcp', externalId: 'mcp-client-1' },
      outcome: { kind: 'attach' },
    })
    expect(
      completeMcpPersonLink(issued.token, personId, testDb.db)
    ).toBeDefined()
  })

  // Rework — the named "ignores a survivor's mergedIntoPersonId" defect: a
  // preview must not promise an outcome completion would then refuse.
  // `completeMcpPersonLink`'s own real `connectIdentity` call refuses
  // outright once `survivorPersonId` names a person merged away
  // (`people.ts`'s own doc comment) — the MCP surface carries no survivor
  // at issue time to repoint on a merge the way a Discord challenge does
  // (`person-link-challenges.ts#repointOutstandingChallenges`), so a
  // survivor merged away *after* the token was issued (a race: a different,
  // faster proof merges the caller into someone else while their own
  // "connect an assistant" token is still unredeemed) is exactly the case
  // that reaches this. Fails without the `previewOutcome` fix: the old code
  // reported `{ kind: 'attach' }` here, a promise `completeMcpPersonLink`
  // would then refuse to keep.
  it('refuses (rather than reporting "attach") when the caller-supplied survivor has since been merged away', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    const issued = issueMcpPersonLinkToken(
      organizationId,
      'mcp-client-1',
      testDb.db
    )
    const otherPerson = people.createPerson(organizationId, {}, testDb.db)
    const merged = people.mergePeople(
      organizationId,
      otherPerson.id,
      personId,
      testDb.db
    )
    if (!merged) throw new Error('setup failed')

    const preview = previewMcpPersonLink(issued.token, personId, testDb.db)

    expect(preview).toBeUndefined()
    // The real completion agrees — it too refuses for the merged-away
    // survivor, so the preview's refusal was honest, not merely different.
    expect(
      completeMcpPersonLink(issued.token, personId, testDb.db)
    ).toBeUndefined()
  })
})

describe('completeMcpPersonLink (LINK-3, LINK-4)', () => {
  it('attaches a never-before-seen MCP identity directly to the caller-supplied survivor', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    const issued = issueMcpPersonLinkToken(
      organizationId,
      'mcp-client-1',
      testDb.db
    )

    const result = completeMcpPersonLink(issued.token, personId, testDb.db)

    expect(result?.id).toBe(personId)
    expect(
      people.resolveIdentity(
        organizationId,
        { surface: 'mcp', externalId: 'mcp-client-1' },
        testDb.db
      )?.id
    ).toBe(personId)
  })

  it('sets connectedAt on a successful attach (finding 1)', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    const issued = issueMcpPersonLinkToken(
      organizationId,
      'mcp-client-1',
      testDb.db
    )

    completeMcpPersonLink(issued.token, personId, testDb.db)

    expect(
      people.getPerson(organizationId, personId, testDb.db)?.connectedAt
    ).not.toBeNull()
  })

  it('refuses a token that was already redeemed', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    const issued = issueMcpPersonLinkToken(
      organizationId,
      'mcp-client-1',
      testDb.db
    )
    completeMcpPersonLink(issued.token, personId, testDb.db)

    expect(
      completeMcpPersonLink(issued.token, personId, testDb.db)
    ).toBeUndefined()
  })

  // D-35 rework, finding 3 — the caller-asserted-identity takeover,
  // reproduced against this exact scenario and shown fixed:
  //
  //   victim   = resolvePersonByIdentity(org, {mcp, 'victim-mcp-id'})
  //   attacker = createPerson(org, {})
  //   issued   = issueMcpPersonLinkToken(org, attacker.id, db) // old signature
  //   completeMcpPersonLink(issued.token, 'victim-mcp-id', db)
  //   → attacker absorbed victim
  //
  // The fix removes the seam the attack used: `issueMcpPersonLinkToken` no
  // longer takes a survivor at all (there is nothing to bind a victim's
  // identity to at issue), and `completeMcpPersonLink` no longer takes an
  // identity to assert — only the survivor, and only the token's own bound
  // identity is ever attached. An attacker's own legitimately-issued token
  // can only ever connect the attacker's own identity, to whichever
  // survivor *they* claim to be — never a victim's.
  it('cannot be used to absorb an unrelated victim — the identity attached is always the token’s own, never caller-asserted', () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrgAndPerson(testDb.db)
    const victim = people.resolvePersonByIdentity(
      organizationId,
      { surface: 'mcp', externalId: 'victim-mcp-id' },
      testDb.db
    )
    const attackerSurvivor = people.createPerson(organizationId, {}, testDb.db)
    // The attacker can only ever issue a token for an identity they
    // themselves possess — here, their own, unrelated MCP id. There is no
    // parameter anywhere in this flow that lets them name the victim's.
    const issued = issueMcpPersonLinkToken(
      organizationId,
      'attacker-own-mcp-id',
      testDb.db
    )

    completeMcpPersonLink(issued.token, attackerSurvivor.id, testDb.db)

    // The attacker's own identity attached to their own survivor — fine.
    expect(
      people.resolveIdentity(
        organizationId,
        { surface: 'mcp', externalId: 'attacker-own-mcp-id' },
        testDb.db
      )?.id
    ).toBe(attackerSurvivor.id)
    // The victim is completely untouched: not merged, not connected, their
    // own identity still resolves to themselves.
    const rereadVictim = people.getPerson(organizationId, victim.id, testDb.db)
    expect(rereadVictim?.mergedIntoPersonId).toBeNull()
    expect(rereadVictim?.connectedAt).toBeNull()
    expect(
      people.resolveIdentity(
        organizationId,
        { surface: 'mcp', externalId: 'victim-mcp-id' },
        testDb.db
      )?.id
    ).toBe(victim.id)
  })

  // D-35 rework, finding 7.
  it('rolls back the consumed token when the attach half fails partway through', () => {
    testDb = createTestDatabase()
    const { organizationId, personId } = seedOrgAndPerson(testDb.db)
    const issued = issueMcpPersonLinkToken(
      organizationId,
      'mcp-client-1',
      testDb.db
    )
    const otherPerson = people.createPerson(organizationId, {}, testDb.db)
    const collidingIdentity = people.connectIdentity(
      organizationId,
      otherPerson.id,
      { surface: 'web', externalId: 'unrelated-account' },
      testDb.db
    )
    if (!collidingIdentity) throw new Error('setup failed')

    const randomUUIDSpy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(
        collidingIdentity.id as `${string}-${string}-${string}-${string}-${string}`
      )

    expect(() =>
      completeMcpPersonLink(issued.token, personId, testDb.db)
    ).toThrow()
    randomUUIDSpy.mockRestore()

    const stillLive = previewMcpPersonLink(issued.token, personId, testDb.db)
    expect(stillLive?.outcome).toEqual({ kind: 'attach' })
  })
})
