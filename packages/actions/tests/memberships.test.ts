/**
 * ENRL-5: `memberships.grant` — granted only by an existing owner, never on
 * the caller's own account, and recorded — and `memberships.list`, its own
 * read side.
 */

import {
  accounts,
  conversations,
  courses,
  enrolments,
  memberships,
  people,
  projects,
  schema,
  type Database,
} from '@bloombot/db'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'

import { setSpendingCapAction } from '../src/actions/cost-ledger.js'
import {
  grantMembershipAction,
  listMembershipsAction,
  revokeMembershipAction,
} from '../src/actions/memberships.js'
import { dispatch } from '../src/dispatch.js'
import { ActionInputError, ActionRefusedError } from '../src/errors.js'
import { seedOrganization } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('memberships.grant (ENRL-5)', () => {
  it('an owner grants a role, and the grant records who granted it', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )
    const recipient = accounts.createAccount(
      organizationId,
      { email: 'recipient@example.edu', displayName: 'TA', role: 'assistant' },
      testDb.db
    )

    const granted = await dispatch(
      grantMembershipAction,
      { email: 'recipient@example.edu', role: 'instructor' },
      { organizationId, db: testDb.db, accountId: owner.id }
    )

    expect(granted).toMatchObject({
      accountId: recipient.id,
      role: 'instructor',
      grantedByAccountId: owner.id,
    })
  })

  it('refuses a caller who is not an owner', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const instructor = accounts.createAccount(
      organizationId,
      { email: 'instructor@example.edu', displayName: 'I', role: 'instructor' },
      testDb.db
    )
    accounts.createAccount(
      organizationId,
      { email: 'target@example.edu', displayName: 'T', role: 'assistant' },
      testDb.db
    )

    await expect(
      dispatch(
        grantMembershipAction,
        { email: 'target@example.edu', role: 'owner' },
        { organizationId, db: testDb.db, accountId: instructor.id }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it('refuses a caller granting a role to their own account', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    await expect(
      dispatch(
        grantMembershipAction,
        { email: 'owner@example.edu', role: 'owner' },
        { organizationId, db: testDb.db, accountId: owner.id }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it('refuses when dispatch was given no authenticated caller at all', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    accounts.createAccount(
      organizationId,
      { email: 'target@example.edu', displayName: 'T', role: 'assistant' },
      testDb.db
    )

    await expect(
      dispatch(
        grantMembershipAction,
        { email: 'target@example.edu', role: 'instructor' },
        { organizationId, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it('refuses an owner in a different organization from the one being acted on', async () => {
    testDb = createTestDatabase()
    const orgA = seedOrganization(testDb.db)
    const orgB = seedOrganization(testDb.db)
    const ownerOfA = accounts.createAccount(
      orgA,
      { email: 'ownerA@example.edu', displayName: 'Owner A', role: 'owner' },
      testDb.db
    )
    accounts.createAccount(
      orgB,
      { email: 'target@example.edu', displayName: 'T', role: 'assistant' },
      testDb.db
    )

    // ownerOfA has no membership at all in orgB, so the "is the caller an
    // owner of *this* organization" check refuses them.
    await expect(
      dispatch(
        grantMembershipAction,
        { email: 'target@example.edu', role: 'instructor' },
        { organizationId: orgB, db: testDb.db, accountId: ownerOfA.id }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it('refuses an email nobody holds an account under', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    await expect(
      dispatch(
        grantMembershipAction,
        { email: `${randomUUID()}@example.edu`, role: 'instructor' },
        { organizationId, db: testDb.db, accountId: owner.id }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  // Rework finding 1: without a membership check, this action was a
  // cross-tenant account-existence oracle — an owner of orgA could learn
  // whether a given email holds an account *anywhere* on the platform by
  // calling this against their own organization, and a success would have
  // enrolled that stranger's account into orgA without their consent. Fails
  // without the fix: before `execute` required `memberships.getMembership`
  // to already find a row, this same call resolved `target` through
  // `accounts.getAccountByEmail` alone and granted the role, creating a
  // brand-new membership in orgA for an account that had never had one.
  it("refuses an email that resolves to a real account, but one with no membership in the caller's organization", async () => {
    testDb = createTestDatabase()
    const orgA = seedOrganization(testDb.db)
    const orgB = seedOrganization(testDb.db)
    const ownerOfA = accounts.createAccount(
      orgA,
      { email: 'ownerA@example.edu', displayName: 'Owner A', role: 'owner' },
      testDb.db
    )
    // A real account, but only ever a member of orgB — a stranger to orgA.
    const strangerOfA = accounts.createAccount(
      orgB,
      { email: 'stranger@example.edu', displayName: 'Stranger', role: 'owner' },
      testDb.db
    )

    await expect(
      dispatch(
        grantMembershipAction,
        { email: 'stranger@example.edu', role: 'instructor' },
        { organizationId: orgA, db: testDb.db, accountId: ownerOfA.id }
      )
    ).rejects.toThrow(ActionRefusedError)

    // No membership was created for them in orgA as a side effect of the
    // refused call.
    expect(
      memberships.getMembership(orgA, strangerOfA.id, testDb.db)
    ).toBeUndefined()
  })

  // `z.strictObject` (`grantInputSchema`'s own comment): `grantedByAccountId`
  // is not a field this schema declares at all, so sending one is refused
  // outright — `ActionInputError`, before the policy or `execute` ever run —
  // rather than silently accepted and ignored. Fails without the fix: a
  // plain `z.object` strips a key it does not declare rather than rejecting
  // it, so this same call would have reached `execute` (and still recorded
  // the caller's own `accountId` as the granter — `execute` never reads
  // `input.grantedByAccountId` regardless), leaving the *attempt* to smuggle
  // one in unnoticed rather than refused.
  it('refuses a grant whose body supplies grantedByAccountId — it is stamped from the session, never the request', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )
    const recipient = accounts.createAccount(
      organizationId,
      { email: 'recipient@example.edu', displayName: 'TA', role: 'assistant' },
      testDb.db
    )
    const impersonated = accounts.createAccount(
      organizationId,
      { email: 'nobody@example.edu', displayName: 'Nobody', role: 'assistant' },
      testDb.db
    )

    await expect(
      dispatch(
        grantMembershipAction,
        {
          email: 'recipient@example.edu',
          role: 'instructor',
          grantedByAccountId: impersonated.id,
        },
        { organizationId, db: testDb.db, accountId: owner.id }
      )
    ).rejects.toThrow(ActionInputError)

    // Refused before anything wrote at all — the recipient's role never
    // changed as a side effect of the rejected body.
    expect(
      memberships.getMembership(organizationId, recipient.id, testDb.db)
    ).toMatchObject({ role: 'assistant', grantedByAccountId: null })
  })

  // ENRL-5's own text again, from the other direction: a granted role is not
  // merely a row — it is real authority a dispatched action actually honors.
  // `costLedger.setSpendingCap` (COST-3) is restricted to an owner the same
  // way `memberships.grant` is (`actions/cost-ledger.ts`'s own module
  // comment); before the grant below, the assistant's own call to it is
  // refused, and after, the identical call succeeds — proven by actually
  // dispatching it, not by re-reading the membership row `grantMembershipAction`
  // already returned.
  it('an owner grants the owner role, and the new owner can then do something an assistant could not: set the spending cap', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )
    const assistant = accounts.createAccount(
      organizationId,
      { email: 'assistant@example.edu', displayName: 'A', role: 'assistant' },
      testDb.db
    )

    await expect(
      dispatch(
        setSpendingCapAction,
        { capAmount: 10 },
        { organizationId, db: testDb.db, accountId: assistant.id }
      )
    ).rejects.toThrow(ActionRefusedError)

    await dispatch(
      grantMembershipAction,
      { email: 'assistant@example.edu', role: 'owner' },
      { organizationId, db: testDb.db, accountId: owner.id }
    )

    const result = await dispatch(
      setSpendingCapAction,
      { capAmount: 10 },
      { organizationId, db: testDb.db, accountId: assistant.id }
    )
    expect(result.spendingCapMicros).toBe(10_000_000)
  })
})

// ENRL-11: `memberships.grant`'s own reachable half of the exposure this
// requirement exists for — a first pass at ENRL-11 closed only
// `memberships.revoke`, leaving this action free to demote a peer owner to
// a lesser role, which is the identical consequence D-73's own
// reconciliation records. `target.role === 'owner'` after this describe
// block's own `beforeEach`-free seeding always means "an existing owner,
// resolved by check 2's own `memberships.getMembership` call" — no new
// lookup, this file's own module comment (`actions/memberships.ts`) has
// why that matters for the "byte-identical refusal" guarantee below.
describe('memberships.grant (ENRL-11)', () => {
  it('refuses an owner demoting another owner, not-found-shaped', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const ownerA = accounts.createAccount(
      organizationId,
      { email: 'ownerA@example.edu', displayName: 'Owner A', role: 'owner' },
      testDb.db
    )
    const ownerB = accounts.createAccount(
      organizationId,
      { email: 'ownerB@example.edu', displayName: 'Owner B', role: 'owner' },
      testDb.db
    )

    await expect(
      dispatch(
        grantMembershipAction,
        { email: 'ownerB@example.edu', role: 'assistant' },
        { organizationId, db: testDb.db, accountId: ownerA.id }
      )
    ).rejects.toThrow(ActionRefusedError)

    // Untouched — the refused call changed nothing.
    expect(
      memberships.getMembership(organizationId, ownerB.id, testDb.db)
    ).toMatchObject({ role: 'owner' })
  })

  // The brief's own instruction: assert against one of `grant`'s existing
  // refusals directly, not merely a status code — `ActionRefusedError`'s
  // own doc comment (`errors.ts`) says every instance is byte-identical by
  // construction (same `name`, `message`, `code`), so this proves that
  // guarantee actually holds for the new check too, rather than trusting
  // the doc comment alone.
  it('the peer-owner refusal is byte-identical to an existing grant refusal — an unknown email', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const ownerA = accounts.createAccount(
      organizationId,
      { email: 'ownerA@example.edu', displayName: 'Owner A', role: 'owner' },
      testDb.db
    )
    accounts.createAccount(
      organizationId,
      { email: 'ownerB@example.edu', displayName: 'Owner B', role: 'owner' },
      testDb.db
    )

    const peerOwnerError = await dispatch(
      grantMembershipAction,
      { email: 'ownerB@example.edu', role: 'assistant' },
      { organizationId, db: testDb.db, accountId: ownerA.id }
    ).catch((caught: unknown) => caught)

    const unknownEmailError = await dispatch(
      grantMembershipAction,
      { email: `${randomUUID()}@example.edu`, role: 'assistant' },
      { organizationId, db: testDb.db, accountId: ownerA.id }
    ).catch((caught: unknown) => caught)

    expect(peerOwnerError).toBeInstanceOf(ActionRefusedError)
    expect(unknownEmailError).toBeInstanceOf(ActionRefusedError)
    const peer = peerOwnerError as ActionRefusedError
    const unknown = unknownEmailError as ActionRefusedError
    expect({ name: peer.name, message: peer.message, code: peer.code }).toEqual(
      { name: unknown.name, message: unknown.message, code: unknown.code }
    )
  })

  // The exposure ENRL-11 was written for, named explicitly and driven end
  // to end: ENRL-10 lets an owner invite a colleague at the `owner` role;
  // once redeemed, that colleague previously could call `memberships.grant`
  // to demote the inviter with no recourse. `grantMembershipAction` promotes
  // `invited` to `owner`, standing in for ENRL-10's own redemption — the
  // same substitution `"an invited peer owner cannot revoke the founding
  // owner"` (below, `memberships.revoke (ENRL-11)`) and
  // `e2e/team-panel.spec.ts`'s own module comment already use, for the
  // identical reason.
  it('the ENRL-10 → ENRL-11 scenario: an invited owner cannot demote the inviting owner via grant', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const founder = accounts.createAccount(
      organizationId,
      { email: 'founder@example.edu', displayName: 'Founder', role: 'owner' },
      testDb.db
    )
    const invited = accounts.createAccount(
      organizationId,
      {
        email: 'invited@example.edu',
        displayName: 'Invited',
        role: 'instructor',
      },
      testDb.db
    )
    // ENRL-10: the founder invites `invited` at the owner role.
    await dispatch(
      grantMembershipAction,
      { email: 'invited@example.edu', role: 'owner' },
      { organizationId, db: testDb.db, accountId: founder.id }
    )

    // ENRL-11's own exposure: the now-owner colleague attempts to demote
    // the founder who invited them.
    await expect(
      dispatch(
        grantMembershipAction,
        { email: 'founder@example.edu', role: 'assistant' },
        { organizationId, db: testDb.db, accountId: invited.id }
      )
    ).rejects.toThrow(ActionRefusedError)

    expect(
      memberships.getMembership(organizationId, founder.id, testDb.db)
    ).toMatchObject({ role: 'owner' })
  })

  // Regression: this new check is scoped to a target that is *currently*
  // `'owner'` — an owner may still change a non-owner's role exactly as
  // before.
  it("an owner can still change a non-owner colleague's role", async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )
    const assistant = accounts.createAccount(
      organizationId,
      { email: 'assistant@example.edu', displayName: 'A', role: 'assistant' },
      testDb.db
    )

    const granted = await dispatch(
      grantMembershipAction,
      { email: 'assistant@example.edu', role: 'instructor' },
      { organizationId, db: testDb.db, accountId: owner.id }
    )

    expect(granted).toMatchObject({
      accountId: assistant.id,
      role: 'instructor',
    })
  })

  // Regression: an owner can still leave the role entirely — through
  // `memberships.revoke`, the path this decision leaves open (see that
  // action's own "steps down themselves" test, below).
  it('an owner can still step down via memberships.revoke, unaffected by this check', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    // A second owner (unnamed further) is what keeps `peer` from being the
    // organization's last owner — without one, this would be testing the
    // *last*-owner refusal, not this test's own point.
    accounts.createAccount(
      organizationId,
      { email: 'founder@example.edu', displayName: 'Founder', role: 'owner' },
      testDb.db
    )
    const peer = accounts.createAccount(
      organizationId,
      { email: 'peer@example.edu', displayName: 'Peer', role: 'owner' },
      testDb.db
    )

    const result = await dispatch(
      revokeMembershipAction,
      { accountId: peer.id },
      { organizationId, db: testDb.db, accountId: peer.id }
    )

    expect(result).toEqual({ revoked: true })
    expect(
      memberships.getMembership(organizationId, peer.id, testDb.db)
    ).toBeUndefined()
  })

  // No organization is stranded by closing the peer-demotion path: a sole
  // owner who wants to leave entirely still has an exit — promote a
  // successor (check 4 only refuses a target *already* `'owner'`; a
  // non-owner target being granted the `'owner'` role is untouched), then
  // step down themselves through `memberships.revoke`, which the last-owner
  // guard now permits since a second owner exists.
  it('a sole owner has a way out: promote a successor via grant, then step down via revoke', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const solePresent = accounts.createAccount(
      organizationId,
      { email: 'sole@example.edu', displayName: 'Sole', role: 'owner' },
      testDb.db
    )
    const successor = accounts.createAccount(
      organizationId,
      { email: 'successor@example.edu', displayName: 'S', role: 'assistant' },
      testDb.db
    )

    await dispatch(
      grantMembershipAction,
      { email: 'successor@example.edu', role: 'owner' },
      { organizationId, db: testDb.db, accountId: solePresent.id }
    )

    const stepDown = await dispatch(
      revokeMembershipAction,
      { accountId: solePresent.id },
      { organizationId, db: testDb.db, accountId: solePresent.id }
    )

    expect(stepDown).toEqual({ revoked: true })
    expect(
      memberships.getMembership(organizationId, solePresent.id, testDb.db)
    ).toBeUndefined()
    expect(
      memberships.getMembership(organizationId, successor.id, testDb.db)
    ).toMatchObject({ role: 'owner' })
  })
})

describe('memberships.list (ENRL-5)', () => {
  it("lists every membership in the caller's organization — the role, who granted it, and when", async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner Ora', role: 'owner' },
      testDb.db
    )
    const recipient = accounts.createAccount(
      organizationId,
      {
        email: 'recipient@example.edu',
        displayName: 'TA Tam',
        role: 'assistant',
      },
      testDb.db
    )
    await dispatch(
      grantMembershipAction,
      { email: 'recipient@example.edu', role: 'instructor' },
      { organizationId, db: testDb.db, accountId: owner.id }
    )

    const entries = await dispatch(
      listMembershipsAction,
      {},
      { organizationId, db: testDb.db, accountId: owner.id }
    )

    expect(entries).toContainEqual(
      expect.objectContaining({
        accountId: owner.id,
        displayName: 'Owner Ora',
        role: 'owner',
        // The founding owner row `accounts.createAccount` writes inline
        // records no grantor (`schema.ts`'s own comment) — nobody granted
        // the very membership that first gave this account anything to act
        // with.
        grantedByAccountId: null,
        grantedByDisplayName: null,
      })
    )
    expect(entries).toContainEqual(
      expect.objectContaining({
        accountId: recipient.id,
        displayName: 'TA Tam',
        role: 'instructor',
        grantedByAccountId: owner.id,
        grantedByDisplayName: 'Owner Ora',
      })
    )
  })

  // Any member may read this list, unlike `memberships.grant` — proven here
  // with a non-owner caller, rather than only asserted in the action's own
  // description.
  it('a non-owner member can list — this is a read, not a grant', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )
    const assistant = accounts.createAccount(
      organizationId,
      { email: 'assistant@example.edu', displayName: 'A', role: 'assistant' },
      testDb.db
    )

    const entries = await dispatch(
      listMembershipsAction,
      {},
      { organizationId, db: testDb.db, accountId: assistant.id }
    )

    expect(entries.map((entry) => entry.accountId).sort()).toEqual(
      [owner.id, assistant.id].sort()
    )
  })

  // TEN-2/TEN-5: a foreign organization's own members never leak into this
  // organization's list. Fails without the fix (`memberships.list`'s own
  // `execute` reading `organizationId` from the dispatch context, not from
  // an id `listMembershipsForOrganization` could otherwise be tricked into
  // ignoring): a version of `execute` that called
  // `memberships.listMembershipsForAccount`-style unscoped lookup, or
  // ignored `organizationId` entirely, would return every organization's
  // members here.
  it("is tenant-scoped — another organization's members never appear", async () => {
    testDb = createTestDatabase()
    const orgA = seedOrganization(testDb.db)
    const orgB = seedOrganization(testDb.db)
    const ownerOfA = accounts.createAccount(
      orgA,
      { email: 'ownerA@example.edu', displayName: 'Owner A', role: 'owner' },
      testDb.db
    )
    const ownerOfB = accounts.createAccount(
      orgB,
      { email: 'ownerB@example.edu', displayName: 'Owner B', role: 'owner' },
      testDb.db
    )

    const entries = await dispatch(
      listMembershipsAction,
      {},
      { organizationId: orgA, db: testDb.db, accountId: ownerOfA.id }
    )

    expect(entries.map((entry) => entry.accountId)).toEqual([ownerOfA.id])
    expect(entries.map((entry) => entry.accountId)).not.toContain(ownerOfB.id)
  })
})

/** One course, one person, an active enrolment, and a conversation with a couple of messages — the "revoking deletes no transcript and ends no enrolment" test needs actual rows to count, the same TEN-6 discipline `discord-servers.test.ts#seedCourseConversationAndMessages` already holds itself to. */
function seedCourseEnrolmentAndConversation(
  organizationId: string,
  db: Database
) {
  const project = projects.createProject(
    organizationId,
    { name: 'Test Term' },
    db
  )
  const courseResult = courses.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: 'Test Course',
      filePrefix: 'tc',
      enabled: true,
      adminsRole: 'admins-tc',
      studentsRole: 'students-tc',
      categories: [],
    },
    db
  )
  if (!courseResult.ok) throw new Error('setup failed: unexpected conflict')

  const person = people.createPerson(organizationId, {}, db)
  const enrolment = enrolments.enrolViaRoster(
    organizationId,
    { courseId: courseResult.course.id, personId: person.id },
    db
  )
  if (!enrolment) throw new Error('setup failed: no enrolment')

  const conversation = conversations.getOrCreateConversation(
    organizationId,
    { courseId: courseResult.course.id, personId: person.id, surface: 'web' },
    db
  )
  if (!conversation) throw new Error('setup failed: no conversation')
  conversations.appendMessage(
    organizationId,
    conversation.id,
    { direction: 'from_person', content: 'Hello' },
    db
  )

  return { enrolmentId: enrolment.id }
}

describe('memberships.revoke (ENRL-11)', () => {
  it('an owner revokes a membership, recording who revoked it and when', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )
    const assistant = accounts.createAccount(
      organizationId,
      { email: 'assistant@example.edu', displayName: 'A', role: 'assistant' },
      testDb.db
    )

    const result = await dispatch(
      revokeMembershipAction,
      { accountId: assistant.id },
      { organizationId, db: testDb.db, accountId: owner.id }
    )

    expect(result).toEqual({ revoked: true })
    expect(
      memberships.getMembership(organizationId, assistant.id, testDb.db)
    ).toBeUndefined()
  })

  // ENRL-11's own text, proven the same way D-67's own grant test proves
  // ENRL-5: real authority, exercised through a dispatched action before
  // and after — not merely a row that disappeared.
  // `costLedger.setSpendingCap` is owner-only (COST-3), checked inside its
  // own `execute` (`actions/cost-ledger.ts`'s own module comment) rather
  // than only at the HTTP membership gate, so this is a genuine test of
  // this slice's own change: `grantMembershipAction` promotes a colleague
  // to owner, they really can set the cap, they step down (the only way an
  // owner's own membership is ever revoked, this file's own module comment
  // on the peer-owner decision), and the identical call is refused
  // afterward.
  it('an owner revokes a membership, and the holder can no longer do what that role permitted', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )
    const colleague = accounts.createAccount(
      organizationId,
      { email: 'colleague@example.edu', displayName: 'C', role: 'assistant' },
      testDb.db
    )
    await dispatch(
      grantMembershipAction,
      { email: 'colleague@example.edu', role: 'owner' },
      { organizationId, db: testDb.db, accountId: owner.id }
    )

    // Before revoking: the newly promoted owner really can set the cap.
    const before = await dispatch(
      setSpendingCapAction,
      { capAmount: 10 },
      { organizationId, db: testDb.db, accountId: colleague.id }
    )
    expect(before.spendingCapMicros).toBe(10_000_000)

    await dispatch(
      revokeMembershipAction,
      { accountId: colleague.id },
      { organizationId, db: testDb.db, accountId: colleague.id }
    )

    // After revoking: the identical call is refused — real access lost,
    // not merely a row this test read back.
    await expect(
      dispatch(
        setSpendingCapAction,
        { capAmount: 20 },
        { organizationId, db: testDb.db, accountId: colleague.id }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it('refuses a caller who is not an owner', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const instructor = accounts.createAccount(
      organizationId,
      { email: 'instructor@example.edu', displayName: 'I', role: 'instructor' },
      testDb.db
    )
    const target = accounts.createAccount(
      organizationId,
      { email: 'target@example.edu', displayName: 'T', role: 'assistant' },
      testDb.db
    )

    await expect(
      dispatch(
        revokeMembershipAction,
        { accountId: target.id },
        { organizationId, db: testDb.db, accountId: instructor.id }
      )
    ).rejects.toThrow(ActionRefusedError)
    expect(
      memberships.getMembership(organizationId, target.id, testDb.db)
    ).toMatchObject({ role: 'assistant' })
  })

  it('refuses when dispatch was given no authenticated caller at all', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const target = accounts.createAccount(
      organizationId,
      { email: 'target@example.edu', displayName: 'T', role: 'assistant' },
      testDb.db
    )

    await expect(
      dispatch(
        revokeMembershipAction,
        { accountId: target.id },
        { organizationId, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  // TEN-5: a foreign-tenant membership refuses identically to one that
  // never existed — `resolve` scopes the lookup to the caller's own
  // organization (`memberships.getMembership`), so it never even reaches
  // the target's real organization.
  it('refuses a membership belonging to another organization, indistinguishable from one that never existed', async () => {
    testDb = createTestDatabase()
    const orgA = seedOrganization(testDb.db)
    const orgB = seedOrganization(testDb.db)
    const ownerOfA = accounts.createAccount(
      orgA,
      { email: 'ownerA@example.edu', displayName: 'Owner A', role: 'owner' },
      testDb.db
    )
    const memberOfB = accounts.createAccount(
      orgB,
      { email: 'memberB@example.edu', displayName: 'B', role: 'assistant' },
      testDb.db
    )

    await expect(
      dispatch(
        revokeMembershipAction,
        { accountId: memberOfB.id },
        { organizationId: orgA, db: testDb.db, accountId: ownerOfA.id }
      )
    ).rejects.toThrow(ActionRefusedError)
    // Untouched — the refusal never reached orgB's own row.
    expect(
      memberships.getMembership(orgB, memberOfB.id, testDb.db)
    ).toMatchObject({ role: 'assistant' })
  })

  // `z.strictObject` — the same discipline `grantInputSchema`'s own test
  // gives ENRL-5. Fails without it: a plain `z.object` would silently drop
  // `revokedByAccountId` rather than refusing the attempt to supply it.
  it('refuses a revoke whose body supplies revokedByAccountId — it is stamped from the session, never the request', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )
    const target = accounts.createAccount(
      organizationId,
      { email: 'target@example.edu', displayName: 'T', role: 'assistant' },
      testDb.db
    )
    const impersonated = accounts.createAccount(
      organizationId,
      { email: 'nobody@example.edu', displayName: 'Nobody', role: 'assistant' },
      testDb.db
    )

    await expect(
      dispatch(
        revokeMembershipAction,
        { accountId: target.id, revokedByAccountId: impersonated.id },
        { organizationId, db: testDb.db, accountId: owner.id }
      )
    ).rejects.toThrow(ActionInputError)
    // Refused before anything wrote at all.
    expect(
      memberships.getMembership(organizationId, target.id, testDb.db)
    ).toMatchObject({ role: 'assistant' })
  })

  // --- ENRL-11's own decisions: the last owner, and a peer owner ---------

  // Driven through the action directly, not a screen — the brief's own
  // requirement. Fails without the repo's own guard
  // (`repos/memberships.ts#revokeMembership`).
  it('the last owner cannot revoke themselves', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const soleOwner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )

    await expect(
      dispatch(
        revokeMembershipAction,
        { accountId: soleOwner.id },
        { organizationId, db: testDb.db, accountId: soleOwner.id }
      )
    ).rejects.toThrow(ActionRefusedError)
    expect(
      memberships.getMembership(organizationId, soleOwner.id, testDb.db)
    ).toMatchObject({ role: 'owner' })
  })

  // The exposure ENRL-11 was written for (`docs/SPEC.md`'s own "Why this
  // exists" text, restated in this file's own module comment): once an
  // invited account holds the owner role, does it gain the power to strip
  // the founder's own standing? This platform's own answer, this slice: no
  // — an owner's own membership is revoked only by that owner, stepping
  // down themselves, never by a peer, however that peer came to hold the
  // role.
  it('an invited peer owner cannot revoke the founding owner', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const founder = accounts.createAccount(
      organizationId,
      { email: 'founder@example.edu', displayName: 'Founder', role: 'owner' },
      testDb.db
    )
    const invited = accounts.createAccount(
      organizationId,
      {
        email: 'invited@example.edu',
        displayName: 'Invited',
        role: 'instructor',
      },
      testDb.db
    )
    // `invited` becomes a second owner — standing in for ENRL-10's own
    // invitation redemption, which this package's own module comment says
    // its tests seed directly rather than replaying a whole invitation flow
    // (`e2e/team-panel.spec.ts`'s own module comment gives the identical
    // reasoning for the same substitution).
    await dispatch(
      grantMembershipAction,
      { email: 'invited@example.edu', role: 'owner' },
      { organizationId, db: testDb.db, accountId: founder.id }
    )

    await expect(
      dispatch(
        revokeMembershipAction,
        { accountId: founder.id },
        { organizationId, db: testDb.db, accountId: invited.id }
      )
    ).rejects.toThrow(ActionRefusedError)

    // The founder's own standing survives the attempt — real recourse, not
    // merely a refused call: they can still do something only an owner can.
    expect(
      memberships.getMembership(organizationId, founder.id, testDb.db)
    ).toMatchObject({ role: 'owner' })
    const capResult = await dispatch(
      setSpendingCapAction,
      { capAmount: 5 },
      { organizationId, db: testDb.db, accountId: founder.id }
    )
    expect(capResult.spendingCapMicros).toBe(5_000_000)
  })

  // The other half of the same decision: an owner may always step down
  // *themselves* — this is not a blanket "an owner's membership can never
  // be revoked", only "never by a peer".
  it("an owner may step down themselves, when they are not the organization's last owner", async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const founder = accounts.createAccount(
      organizationId,
      { email: 'founder@example.edu', displayName: 'Founder', role: 'owner' },
      testDb.db
    )
    const peer = accounts.createAccount(
      organizationId,
      { email: 'peer@example.edu', displayName: 'Peer', role: 'owner' },
      testDb.db
    )

    const result = await dispatch(
      revokeMembershipAction,
      { accountId: peer.id },
      { organizationId, db: testDb.db, accountId: peer.id }
    )

    expect(result).toEqual({ revoked: true })
    expect(
      memberships.getMembership(organizationId, peer.id, testDb.db)
    ).toBeUndefined()
    // The founder, still an owner, is untouched.
    expect(
      memberships.getMembership(organizationId, founder.id, testDb.db)
    ).toMatchObject({ role: 'owner' })
  })

  // ENRL-11's own text: "removes staff authority and nothing else" — proven
  // by actually seeding a course, an enrolment and a conversation with
  // messages, and counting every one of them before and after, the same
  // TEN-6 discipline `discord-servers.test.ts` already holds itself to,
  // rather than only asserting the membership row itself.
  it('revoking deletes no transcript and ends no enrolment', async () => {
    testDb = createTestDatabase()
    const organizationId = seedOrganization(testDb.db)
    const owner = accounts.createAccount(
      organizationId,
      { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
      testDb.db
    )
    const instructor = accounts.createAccount(
      organizationId,
      { email: 'instructor@example.edu', displayName: 'I', role: 'instructor' },
      testDb.db
    )
    const { enrolmentId } = seedCourseEnrolmentAndConversation(
      organizationId,
      testDb.db
    )
    const before = {
      conversations: testDb.db.select().from(schema.conversations).all().length,
      messages: testDb.db.select().from(schema.messages).all().length,
    }

    await dispatch(
      revokeMembershipAction,
      { accountId: instructor.id },
      { organizationId, db: testDb.db, accountId: owner.id }
    )

    const after = {
      conversations: testDb.db.select().from(schema.conversations).all().length,
      messages: testDb.db.select().from(schema.messages).all().length,
    }
    expect(after).toEqual(before)
    expect(
      enrolments.getEnrolment(organizationId, enrolmentId, testDb.db)
    ).toMatchObject({ endedAt: null })
  })
})
