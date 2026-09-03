/**
 * ENRL-10: `membershipInvitations.create`/`.list`/`.revoke` — the dispatched
 * half — and `redeemMembershipInvitationForWebAccount`, the composed
 * redemption entry point `apps/api`'s own route calls (not a dispatched
 * `Action`; see `membership-invitations.ts`'s own module comment).
 */

import { accounts, memberships } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import { setSpendingCapAction } from '../src/actions/cost-ledger.js'
import {
  createMembershipInvitationAction,
  listMembershipInvitationsAction,
  redeemMembershipInvitationForWebAccount,
  revokeMembershipInvitationAction,
} from '../src/actions/membership-invitations.js'
import { dispatch } from '../src/dispatch.js'
import { ActionInputError, ActionRefusedError } from '../src/errors.js'
import { seedOrganization } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** An owner account in a fresh organization — every case below invites through this account. */
function seedOwner(db: TestDatabase['db']) {
  const organizationId = seedOrganization(db)
  const owner = accounts.createAccount(
    organizationId,
    { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
    db
  )
  return { organizationId, ownerId: owner.id }
}

describe('membershipInvitations.create (ENRL-10)', () => {
  it('an owner invites an address, and the secret is returned exactly once', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId } = seedOwner(testDb.db)

    const created = await dispatch(
      createMembershipInvitationAction,
      { email: 'colleague@example.edu', role: 'instructor' },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    expect(created.secret.length).toBeGreaterThan(0)
    expect(created.invitationId.length).toBeGreaterThan(0)
    expect(created.expiresAt).toBeNull()

    // Never in the list projection — this is the one place the secret ever
    // appears at all (`MembershipInvitationSummary`'s own doc comment).
    const list = await dispatch(
      listMembershipInvitationsAction,
      {},
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    expect(list).toHaveLength(1)
    expect(list[0]).not.toHaveProperty('secret')
    expect(list[0]).not.toHaveProperty('secretHash')
  })

  it('refuses a caller who is not an owner', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const instructor = accounts.createAccount(
      organizationId,
      { email: 'instructor@example.edu', displayName: 'I', role: 'instructor' },
      testDb.db
    )

    await expect(
      dispatch(
        createMembershipInvitationAction,
        { email: 'colleague@example.edu', role: 'instructor' },
        { organizationId, db: testDb.db, accountId: instructor.id }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it('refuses when dispatch was given no authenticated caller at all', async () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOwner(testDb.db)

    await expect(
      dispatch(
        createMembershipInvitationAction,
        { email: 'colleague@example.edu', role: 'instructor' },
        { organizationId, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  // ENRL-10's own reason for existing: inviting an address with no account
  // must be indistinguishable, from the caller's own point of view, from
  // inviting one that has one — `createMembershipInvitationAction` never
  // looks `email` up against `accounts` at all, so both calls below succeed
  // with the identical response shape.
  it('inviting an address with no account behaves identically to inviting one that has one', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId } = seedOwner(testDb.db)
    accounts.createAccount(
      organizationId,
      { email: 'has-account@example.edu', displayName: 'X', role: 'assistant' },
      testDb.db
    )

    const withoutAccount = await dispatch(
      createMembershipInvitationAction,
      { email: 'no-account-here@example.edu', role: 'instructor' },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    const withAccount = await dispatch(
      createMembershipInvitationAction,
      { email: 'has-account@example.edu', role: 'instructor' },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    expect(Object.keys(withoutAccount).sort()).toEqual(
      Object.keys(withAccount).sort()
    )
    expect(typeof withoutAccount.secret).toBe('string')
    expect(typeof withAccount.secret).toBe('string')
  })

  // `z.strictObject`, the same "a plain z.object silently strips a key it
  // does not declare rather than refusing it" device `memberships.grant`'s
  // own `grantInputSchema` already uses (`actions/memberships.ts`, D-67) —
  // `execute` always stamps `createdByAccountId` from the session
  // (`requireOwner`), never from `input`, so a caller supplying one is
  // refused outright rather than silently ignored.
  it('refuses a create body carrying createdByAccountId — it is stamped from the session, never the request', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId } = seedOwner(testDb.db)
    const impersonated = accounts.createAccount(
      seedOrganization(testDb.db),
      { email: 'nobody@example.edu', displayName: 'Nobody', role: 'owner' },
      testDb.db
    )

    await expect(
      dispatch(
        createMembershipInvitationAction,
        {
          email: 'colleague@example.edu',
          role: 'instructor',
          createdByAccountId: impersonated.id,
        },
        { organizationId, db: testDb.db, accountId: ownerId }
      )
    ).rejects.toThrow(ActionInputError)
  })
})

describe('membershipInvitations.list (ENRL-10)', () => {
  it('refuses a caller who is not an owner', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const assistant = accounts.createAccount(
      organizationId,
      { email: 'assistant@example.edu', displayName: 'A', role: 'assistant' },
      testDb.db
    )

    await expect(
      dispatch(
        listMembershipInvitationsAction,
        {},
        { organizationId, db: testDb.db, accountId: assistant.id }
      )
    ).rejects.toThrow(ActionRefusedError)
  })
})

describe('membershipInvitations.revoke (ENRL-10)', () => {
  it('refuses a caller who is not an owner', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId } = seedOwner(testDb.db)
    const assistant = accounts.createAccount(
      organizationId,
      { email: 'assistant@example.edu', displayName: 'A', role: 'assistant' },
      testDb.db
    )
    const created = await dispatch(
      createMembershipInvitationAction,
      { email: 'colleague@example.edu', role: 'instructor' },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    await expect(
      dispatch(
        revokeMembershipInvitationAction,
        { invitationId: created.invitationId },
        { organizationId, db: testDb.db, accountId: assistant.id }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it('stops a revoked invitation admitting anyone, even the person it was addressed to', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId } = seedOwner(testDb.db)
    const created = await dispatch(
      createMembershipInvitationAction,
      { email: 'colleague@example.edu', role: 'instructor' },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    await dispatch(
      revokeMembershipInvitationAction,
      { invitationId: created.invitationId },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    // A fresh, real organization for that account — unrelated to the one
    // the invitation was issued in, the same "the account's own personal
    // organization" shape `redeemMembershipInvitationForWebAccount`'s own
    // test below uses.
    const invitee = accounts.createAccount(
      seedOrganization(testDb.db),
      {
        email: 'colleague@example.edu',
        displayName: 'Colleague',
        role: 'owner',
      },
      testDb.db
    )

    const granted = redeemMembershipInvitationForWebAccount(
      created.secret,
      invitee.id,
      testDb.db
    )
    expect(granted).toBeUndefined()
  })
})

describe('redeemMembershipInvitationForWebAccount (ENRL-10)', () => {
  // The requirement's own centerpiece: an invited colleague with no prior
  // membership redeems and gains the role — proved by dispatching a real
  // action the new role permits, not by reading the row back.
  // `costLedger.setSpendingCap` is owner-only (`actions/cost-ledger.ts`'s
  // own module comment), the same "a granted role is real authority"
  // integration `memberships.test.ts` already uses for `memberships.grant`.
  it('an invited colleague with no prior membership redeems and gains the role — proved by a real owner-only action', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId } = seedOwner(testDb.db)
    const created = await dispatch(
      createMembershipInvitationAction,
      { email: 'colleague@example.edu', role: 'owner' },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    const invitee = accounts.createAccount(
      seedOrganization(testDb.db),
      {
        email: 'colleague@example.edu',
        displayName: 'Colleague',
        role: 'owner',
      },
      testDb.db
    )

    // Before redemption: an owner-only action refuses this account entirely
    // outside its own personal organization.
    await expect(
      dispatch(
        setSpendingCapAction,
        { capAmount: 10 },
        {
          organizationId,
          db: testDb.db,
          accountId: invitee.id,
        }
      )
    ).rejects.toThrow(ActionRefusedError)

    const granted = redeemMembershipInvitationForWebAccount(
      created.secret,
      invitee.id,
      testDb.db
    )
    expect(granted).toMatchObject({ role: 'owner' })

    // After redemption: the same action, against the same organization,
    // now succeeds for this account — real authority, not merely a row.
    const capResult = await dispatch(
      setSpendingCapAction,
      { capAmount: 10 },
      {
        organizationId,
        db: testDb.db,
        accountId: invitee.id,
      }
    )
    expect(capResult.spendingCapMicros).toBe(10_000_000)
  })

  // ENRL-5's own "recorded" requirement: the grantor is the inviting owner,
  // never the redeemer — even though the redeemer is the account the write
  // actually authenticates as.
  it('records the inviting owner as grantedByAccountId, not the redeemer', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId } = seedOwner(testDb.db)
    const created = await dispatch(
      createMembershipInvitationAction,
      { email: 'colleague@example.edu', role: 'instructor' },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    const invitee = accounts.createAccount(
      seedOrganization(testDb.db),
      {
        email: 'colleague@example.edu',
        displayName: 'Colleague',
        role: 'owner',
      },
      testDb.db
    )

    const granted = redeemMembershipInvitationForWebAccount(
      created.secret,
      invitee.id,
      testDb.db
    )

    expect(granted?.grantedByAccountId).toBe(ownerId)
    expect(granted?.grantedByAccountId).not.toBe(invitee.id)
  })

  // Changing an existing member's role is `memberships.grant`'s own job
  // (ENRL-5), not an invitation's — redeeming refuses rather than silently
  // reassigning a role for an account already a member.
  it('refuses when the redeeming account already holds a membership in that organization, leaving the existing role untouched', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId } = seedOwner(testDb.db)
    const existingMember = accounts.createAccount(
      organizationId,
      {
        email: 'already-here@example.edu',
        displayName: 'Existing',
        role: 'assistant',
      },
      testDb.db
    )
    const created = await dispatch(
      createMembershipInvitationAction,
      { email: 'already-here@example.edu', role: 'instructor' },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    const granted = redeemMembershipInvitationForWebAccount(
      created.secret,
      existingMember.id,
      testDb.db
    )

    expect(granted).toBeUndefined()
    expect(
      memberships.getMembership(organizationId, existingMember.id, testDb.db)
    ).toMatchObject({ role: 'assistant' })
  })
})
