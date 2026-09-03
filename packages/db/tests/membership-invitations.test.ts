import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  accounts,
  closeDatabase,
  membershipInvitations,
  memberships,
  openDatabase,
  organizations,
} from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Seeds an organization with one owning account, synthetic data only (QA-3). */
function seedOrganization(testDatabase: TestDatabase) {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Org A', isPersonal: false },
    testDatabase.db
  )
  const owner = accounts.createAccount(
    organizationId,
    {
      email: `${randomUUID()}@example.edu`,
      displayName: 'Owner',
      role: 'owner',
    },
    testDatabase.db
  )
  return { organizationId, ownerId: owner.id }
}

/** An account with a known, chosen email — the redeemer half of a scenario that needs to control the address (ENRL-10's own email-match check). */
function seedAccountWithEmail(
  testDatabase: TestDatabase,
  email: string
): { organizationId: string; accountId: string } {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Personal', isPersonal: true },
    testDatabase.db
  )
  const account = accounts.createAccount(
    organizationId,
    { email, displayName: 'Invitee', role: 'owner' },
    testDatabase.db
  )
  return { organizationId, accountId: account.id }
}

describe('membership-invitations repo (ENRL-10)', () => {
  // --- The secret is returned once and stored only as a hash -------------

  it('stores only the hash — the row never carries the plaintext secret', () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId } = seedOrganization(testDb)

    const invitation = membershipInvitations.createInvitation(
      organizationId,
      {
        email: 'invitee@example.edu',
        role: 'instructor',
        secretHash: 'hash-of-a-secret',
        createdByAccountId: ownerId,
      },
      testDb.db
    )

    expect(invitation.secretHash).toBe('hash-of-a-secret')
    expect(Object.values(invitation)).not.toContain('the-real-secret')
  })

  it('stores email lowercased, regardless of how it was typed', () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId } = seedOrganization(testDb)

    const invitation = membershipInvitations.createInvitation(
      organizationId,
      {
        email: 'Invitee@Example.EDU',
        role: 'instructor',
        secretHash: 'hash-1',
        createdByAccountId: ownerId,
      },
      testDb.db
    )

    expect(invitation.email).toBe('invitee@example.edu')
  })

  // --- ENRL-10: an invited colleague with no prior membership redeems and
  // gains the role -----------------------------------------------------

  it('redemption grants the invited role to an account with no prior membership', () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId } = seedOrganization(testDb)
    const { accountId } = seedAccountWithEmail(testDb, 'invitee@example.edu')

    membershipInvitations.createInvitation(
      organizationId,
      {
        email: 'invitee@example.edu',
        role: 'instructor',
        secretHash: 'hash-1',
        createdByAccountId: ownerId,
      },
      testDb.db
    )

    const granted = membershipInvitations.redeemMembershipInvitation(
      'hash-1',
      accountId,
      Date.now(),
      testDb.db
    )

    expect(granted).toBeDefined()
    expect(granted?.role).toBe('instructor')
    expect(
      memberships.getMembership(organizationId, accountId, testDb.db)
    ).toMatchObject({ role: 'instructor' })
  })

  // The recorded grantor is the issuing owner, never the redeemer.
  it('records the inviting owner as grantedByAccountId, not the redeemer', () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId } = seedOrganization(testDb)
    const { accountId } = seedAccountWithEmail(testDb, 'invitee@example.edu')

    membershipInvitations.createInvitation(
      organizationId,
      {
        email: 'invitee@example.edu',
        role: 'assistant',
        secretHash: 'hash-1',
        createdByAccountId: ownerId,
      },
      testDb.db
    )

    const granted = membershipInvitations.redeemMembershipInvitation(
      'hash-1',
      accountId,
      Date.now(),
      testDb.db
    )

    expect(granted?.grantedByAccountId).toBe(ownerId)
    expect(granted?.grantedByAccountId).not.toBe(accountId)
  })

  // A body-supplied account id cannot redirect the grant to someone else —
  // this repo function has no such parameter at all: `accountId` always
  // comes from the caller, never from anything the invitation itself
  // carries, so there is nothing here to redirect. The only thing left to
  // pin is that the invited *email* actually gates who may redeem.
  it("refuses when the redeeming account's own email does not match the invited address", () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId } = seedOrganization(testDb)
    const { accountId } = seedAccountWithEmail(
      testDb,
      'somebody-else@example.edu'
    )

    membershipInvitations.createInvitation(
      organizationId,
      {
        email: 'invitee@example.edu',
        role: 'instructor',
        secretHash: 'hash-1',
        createdByAccountId: ownerId,
      },
      testDb.db
    )

    const granted = membershipInvitations.redeemMembershipInvitation(
      'hash-1',
      accountId,
      Date.now(),
      testDb.db
    )

    expect(granted).toBeUndefined()
    expect(
      memberships.getMembership(organizationId, accountId, testDb.db)
    ).toBeUndefined()
    // Refusing left the invitation live — a mismatched attempt must not
    // burn the one legitimate redemption the actual invitee still has
    // coming.
    expect(
      membershipInvitations.redeemMembershipInvitation(
        'hash-1',
        seedAccountWithEmail(testDb, 'invitee@example.edu').accountId,
        Date.now(),
        testDb.db
      )
    ).toBeDefined()
  })

  // Silently changing an existing member's role via an invitation is a
  // different act from granting a first one (this repo's own doc comment,
  // and `@bloombot/actions`' `memberships.ts` — that action stays the one
  // path for changing an existing member's role).
  it('refuses when the redeeming account already holds a membership in that organization', () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId } = seedOrganization(testDb)
    const { accountId } = seedAccountWithEmail(
      testDb,
      'already-here@example.edu'
    )
    memberships.createMembership(
      organizationId,
      accountId,
      'assistant',
      testDb.db
    )

    membershipInvitations.createInvitation(
      organizationId,
      {
        email: 'already-here@example.edu',
        role: 'instructor',
        secretHash: 'hash-1',
        createdByAccountId: ownerId,
      },
      testDb.db
    )

    const granted = membershipInvitations.redeemMembershipInvitation(
      'hash-1',
      accountId,
      Date.now(),
      testDb.db
    )

    expect(granted).toBeUndefined()
    // The role this account already held is untouched.
    expect(
      memberships.getMembership(organizationId, accountId, testDb.db)
    ).toMatchObject({ role: 'assistant' })
  })

  // --- ENRL-10's own "no oracle" shape: never-issued, revoked, expired and
  // already-redeemed all refuse identically -------------------------------

  it('never-issued, revoked, expired and already-redeemed secrets all refuse the same way', () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId } = seedOrganization(testDb)

    const revoked = membershipInvitations.createInvitation(
      organizationId,
      {
        email: 'a@example.edu',
        role: 'instructor',
        secretHash: 'hash-revoked',
        createdByAccountId: ownerId,
      },
      testDb.db
    )
    membershipInvitations.revokeInvitation(
      organizationId,
      revoked.id,
      testDb.db
    )

    membershipInvitations.createInvitation(
      organizationId,
      {
        email: 'b@example.edu',
        role: 'instructor',
        secretHash: 'hash-expired',
        expiresAt: Date.now() - 1000,
        createdByAccountId: ownerId,
      },
      testDb.db
    )

    membershipInvitations.createInvitation(
      organizationId,
      {
        email: 'c@example.edu',
        role: 'instructor',
        secretHash: 'hash-redeemed',
        createdByAccountId: ownerId,
      },
      testDb.db
    )
    const { accountId: redeemedAccountId } = seedAccountWithEmail(
      testDb,
      'c@example.edu'
    )
    membershipInvitations.redeemMembershipInvitation(
      'hash-redeemed',
      redeemedAccountId,
      Date.now(),
      testDb.db
    )

    for (const secretHash of [
      'never-issued-hash',
      'hash-revoked',
      'hash-expired',
      'hash-redeemed',
    ]) {
      const { accountId } = seedAccountWithEmail(
        testDb,
        `${randomUUID()}@example.edu`
      )
      expect(
        membershipInvitations.redeemMembershipInvitation(
          secretHash,
          accountId,
          Date.now(),
          testDb.db
        )
      ).toBeUndefined()
    }
  })

  // The test above proves the four reasons *return* the same thing;
  // mutation testing this slice's own brief calls for found that alone
  // does not prove they take the same *path* — dropping `revokedAt` from
  // `findLiveInvitationByHash`'s own `WHERE` still returned `undefined` for
  // a revoked secret, because `claimInvitation`'s own re-check (its "a
  // write whose own WHERE re-checks the condition its read relied on"
  // reasoning) refused it anyway, just one step later, after doing more
  // work first. That extra work is an observable difference — a caller
  // measuring how much this function does before refusing could tell a
  // revoked secret from a never-issued one, an oracle by timing rather
  // than by return value. This pins the stronger claim directly: none of
  // the four ever reaches `accounts.getAccountById` at all — the same
  // "refuses before any extra work runs" property
  // `course-join-links.ts#redeemJoinLinkForWebAccount`'s own doc comment
  // already holds itself to.
  it('never-issued, revoked, expired and already-redeemed all refuse before doing any further work — none of them reach getAccountById', () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId } = seedOrganization(testDb)

    const revoked = membershipInvitations.createInvitation(
      organizationId,
      {
        email: 'a@example.edu',
        role: 'instructor',
        secretHash: 'hash-revoked-2',
        createdByAccountId: ownerId,
      },
      testDb.db
    )
    membershipInvitations.revokeInvitation(
      organizationId,
      revoked.id,
      testDb.db
    )
    membershipInvitations.createInvitation(
      organizationId,
      {
        email: 'b@example.edu',
        role: 'instructor',
        secretHash: 'hash-expired-2',
        expiresAt: Date.now() - 1000,
        createdByAccountId: ownerId,
      },
      testDb.db
    )
    membershipInvitations.createInvitation(
      organizationId,
      {
        email: 'c@example.edu',
        role: 'instructor',
        secretHash: 'hash-redeemed-2',
        createdByAccountId: ownerId,
      },
      testDb.db
    )
    const { accountId: redeemedAccountId } = seedAccountWithEmail(
      testDb,
      'c@example.edu'
    )
    membershipInvitations.redeemMembershipInvitation(
      'hash-redeemed-2',
      redeemedAccountId,
      Date.now(),
      testDb.db
    )

    const spy = vi.spyOn(accounts, 'getAccountById')
    try {
      for (const secretHash of [
        'never-issued-hash-2',
        'hash-revoked-2',
        'hash-expired-2',
        'hash-redeemed-2',
      ]) {
        const { accountId } = seedAccountWithEmail(
          testDb,
          `${randomUUID()}@example.edu`
        )
        spy.mockClear()
        membershipInvitations.redeemMembershipInvitation(
          secretHash,
          accountId,
          Date.now(),
          testDb.db
        )
        expect(spy, secretHash).not.toHaveBeenCalled()
      }
    } finally {
      spy.mockRestore()
    }
  })

  // Single-use: a second redemption attempt of an already-redeemed secret,
  // even by the very account that redeemed it first, gains nothing more.
  it('is single-use: a second redemption of the same secret grants nothing', () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId } = seedOrganization(testDb)
    const { accountId } = seedAccountWithEmail(testDb, 'invitee@example.edu')

    membershipInvitations.createInvitation(
      organizationId,
      {
        email: 'invitee@example.edu',
        role: 'instructor',
        secretHash: 'hash-1',
        createdByAccountId: ownerId,
      },
      testDb.db
    )

    const first = membershipInvitations.redeemMembershipInvitation(
      'hash-1',
      accountId,
      Date.now(),
      testDb.db
    )
    expect(first).toBeDefined()

    const second = membershipInvitations.redeemMembershipInvitation(
      'hash-1',
      accountId,
      Date.now(),
      testDb.db
    )
    expect(second).toBeUndefined()
  })

  // --- Revoking -----------------------------------------------------------

  it('revoking is idempotent: a second revoke changes nothing further', () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId } = seedOrganization(testDb)
    const invitation = membershipInvitations.createInvitation(
      organizationId,
      {
        email: 'a@example.edu',
        role: 'instructor',
        secretHash: 'hash-1',
        createdByAccountId: ownerId,
      },
      testDb.db
    )

    expect(
      membershipInvitations.revokeInvitation(
        organizationId,
        invitation.id,
        testDb.db
      )
    ).toBe(1)
    expect(
      membershipInvitations.revokeInvitation(
        organizationId,
        invitation.id,
        testDb.db
      )
    ).toBe(0)
  })

  // --- Rework-class finding: redemption is atomic -------------------------

  // Mirrors `course-join-links.test.ts`'s own "redemption is atomic" case,
  // including its own tolerance for either outcome: a concurrent revoke,
  // committed through a second real connection to the same file, races an
  // in-flight redemption after this transaction's own reads already ran.
  // Either SQLite itself refuses the later write against a now-stale
  // snapshot (a thrown "database is locked", WAL's own conflict detection —
  // the same exception that file's own test catches and ignores), or
  // `claimInvitation`'s own `UPDATE` re-checking the same liveness
  // conditions its read relied on affects zero rows and resolves cleanly.
  // What this test actually pins down is the assertion below, which holds
  // either way: no membership was granted.
  it('redemption is atomic: a revoke racing with an in-flight redemption cannot let the grant through', () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId } = seedOrganization(testDb)
    const { accountId } = seedAccountWithEmail(testDb, 'invitee@example.edu')

    const invitation = membershipInvitations.createInvitation(
      organizationId,
      {
        email: 'invitee@example.edu',
        role: 'instructor',
        secretHash: 'hash-1',
        createdByAccountId: ownerId,
      },
      testDb.db
    )

    // A second connection to the very same file — standing in for a
    // different process (`apps/api`, revoking this invitation) racing
    // against another mid-redemption of it.
    const secondConnection = openDatabase(testDb.path)
    const realGetAccountById = accounts.getAccountById
    const spy = vi
      .spyOn(accounts, 'getAccountById')
      .mockImplementationOnce((...args) => {
        // Fires from inside `redeemMembershipInvitation`'s own transaction,
        // after its own liveness read and before its claim — exactly the
        // race window a claim with no re-check would leave open.
        membershipInvitations.revokeInvitation(
          organizationId,
          invitation.id,
          secondConnection
        )
        return realGetAccountById(...args)
      })

    let granted: memberships.Membership | undefined
    try {
      granted = membershipInvitations.redeemMembershipInvitation(
        'hash-1',
        accountId,
        Date.now(),
        testDb.db
      )
    } catch {
      // Either outcome — a thrown write-conflict, or a clean `undefined` —
      // is acceptable here; see this test's own comment above.
    } finally {
      spy.mockRestore()
      closeDatabase(secondConnection)
    }

    expect(granted).toBeUndefined()
    expect(
      memberships.getMembership(organizationId, accountId, testDb.db)
    ).toBeUndefined()
    expect(
      membershipInvitations.getInvitation(
        organizationId,
        invitation.id,
        testDb.db
      )
    ).toMatchObject({ revokedAt: expect.any(Number) })
  })

  // The mutation-testing half of the atomicity property, distinct from the
  // revoke race above: the claim (`redeemedAt`) and the grant
  // (`grantMembershipRole`'s own write) must commit or roll back
  // *together*. Mutation testing this slice's own brief calls for found
  // that moving the claim and the grant into two separate transactions
  // (rather than the one `db.transaction(...)` wraps both in) survives
  // every other test in this file, because none of them fail *between* the
  // two writes — this is the one that does, by making the grant itself
  // throw after the claim has already run. Fails without a single
  // transaction wrapping both: a claimed invitation with no corresponding
  // membership is worse than a redemption that simply failed — the
  // legitimate invitee is now locked out (the invitation is single-use)
  // with nothing to show for it.
  it('redemption is atomic: a failure between the claim and the grant leaves neither, not a claimed invitation with no membership', () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId } = seedOrganization(testDb)
    const { accountId } = seedAccountWithEmail(testDb, 'invitee@example.edu')

    const invitation = membershipInvitations.createInvitation(
      organizationId,
      {
        email: 'invitee@example.edu',
        role: 'instructor',
        secretHash: 'hash-1',
        createdByAccountId: ownerId,
      },
      testDb.db
    )

    const spy = vi
      .spyOn(memberships, 'grantMembershipRole')
      .mockImplementationOnce(() => {
        throw new Error('simulated failure after the claim')
      })

    let caught: unknown
    try {
      membershipInvitations.redeemMembershipInvitation(
        'hash-1',
        accountId,
        Date.now(),
        testDb.db
      )
    } catch (error) {
      caught = error
    } finally {
      spy.mockRestore()
    }

    expect(caught).toBeInstanceOf(Error)
    // The transaction rolled the claim back along with the grant — the
    // invitation is still live, not burned on a failed attempt, and the
    // account holds no membership from it.
    expect(
      membershipInvitations.getInvitation(
        organizationId,
        invitation.id,
        testDb.db
      )
    ).toMatchObject({ redeemedAt: null, redeemedByAccountId: null })
    expect(
      memberships.getMembership(organizationId, accountId, testDb.db)
    ).toBeUndefined()

    // And the invitation is still genuinely redeemable — proof the rollback
    // was real, not merely "the row looks unclaimed but is actually dead".
    expect(
      membershipInvitations.redeemMembershipInvitation(
        'hash-1',
        accountId,
        Date.now(),
        testDb.db
      )
    ).toMatchObject({ role: 'instructor' })
  })

  // --- Listing --------------------------------------------------------

  it('lists invitations newest first, across live, revoked and redeemed alike', () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId } = seedOrganization(testDb)

    // Fake timers so two invitations minted back to back land in different
    // milliseconds — without this, `createdAt` can tie, and SQLite's own
    // `ORDER BY` gives no guaranteed order among tied rows (the same caveat
    // `course-join-links.ts#listJoinLinks`'s own doc comment names, and the
    // same fix `course-join-links.test.ts`'s own "newest first" case uses).
    vi.useFakeTimers()
    let first: membershipInvitations.MembershipInvitation
    let second: membershipInvitations.MembershipInvitation
    try {
      vi.setSystemTime(new Date('2026-08-31T00:00:00.000Z'))
      first = membershipInvitations.createInvitation(
        organizationId,
        {
          email: 'a@example.edu',
          role: 'instructor',
          secretHash: 'hash-a',
          createdByAccountId: ownerId,
        },
        testDb.db
      )
      vi.setSystemTime(new Date('2026-08-31T00:00:00.001Z'))
      second = membershipInvitations.createInvitation(
        organizationId,
        {
          email: 'b@example.edu',
          role: 'assistant',
          secretHash: 'hash-b',
          createdByAccountId: ownerId,
        },
        testDb.db
      )
    } finally {
      vi.useRealTimers()
    }

    const list = membershipInvitations.listInvitations(
      organizationId,
      testDb.db
    )
    expect(list.map((row) => row.id)).toEqual([second.id, first.id])
  })
})
