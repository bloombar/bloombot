/**
 * ENRL-10, over HTTP: `POST /membership-invitations/redeem` — an invitation,
 * redeemed bound to the caller's own signed-in session, never a
 * request-body-supplied identity.
 *
 * `seedInvitation` writes the invitation directly through `@bloombot/db`'s
 * own `membershipInvitations.createInvitation`, hashing a known plaintext
 * with the same SHA-256-over-the-raw-string algorithm `@bloombot/actions`'
 * (module-private) `hashSecret` uses — `createMembershipInvitationAction`
 * is not part of `@bloombot/actions`' own public root export (only
 * `createPlatformRegistry` bundles it, for `routes/actions.ts`'s
 * dispatcher), so this file cannot import it directly;
 * `apps/api/tests/routes/join-links.test.ts` already establishes this same
 * "known plaintext, hash it the same way" pattern for exactly this reason.
 */

import { createHash, randomUUID } from 'node:crypto'

import { createSession } from '@bloombot/auth'
import {
  accounts,
  membershipInvitations,
  memberships,
  organizations,
  type Database,
} from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import { buildTestApp, TEST_PUBLIC_APP_URL } from '../helpers/build-test-app.js'
import { seedSignedInCaller, type SignedInCaller } from '../helpers/seed.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'
import { SESSION_COOKIE_NAME } from '../../src/middleware/session.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** The same hash `@bloombot/actions`' own (module-private) `hashSecret` computes — see this file's own module comment. */
function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** A live invitation, issued by `issuer`, addressed to `email`. */
function seedInvitation(
  db: Database,
  issuer: SignedInCaller,
  options: {
    secret?: string
    email?: string
    role?: memberships.MembershipRole
    expiresAt?: number | null
  } = {}
): { invitationId: string; secret: string; email: string } {
  const secret = options.secret ?? `secret-${randomUUID()}`
  const email = options.email ?? `invitee-${randomUUID()}@example.edu`
  const invitation = membershipInvitations.createInvitation(
    issuer.organizationId,
    {
      email,
      role: options.role ?? 'instructor',
      secretHash: hashSecret(secret),
      expiresAt: options.expiresAt ?? null,
      createdByAccountId: issuer.accountId,
    },
    db
  )

  return { invitationId: invitation.id, secret, email }
}

/** A signed-in account whose own email is `email`, in a fresh organization of its own. */
function seedAccountWithEmail(
  db: Database,
  email: string
): { accountId: string; cookieHeader: string } {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Personal', isPersonal: true },
    db
  )
  const account = accounts.createAccount(
    organizationId,
    { email, displayName: 'Invitee', role: 'owner' },
    db
  )
  const session = createSession(account.id, db)
  return {
    accountId: account.id,
    cookieHeader: `${SESSION_COOKIE_NAME}=${session.token}`,
  }
}

describe('routes/membership-invitations.ts (ENRL-10)', () => {
  it('a signed-out caller is told to sign in', async () => {
    testDb = createTestDatabase()
    const issuer = seedSignedInCaller(testDb.db)
    const { secret } = seedInvitation(testDb.db, issuer)

    const app = await buildTestApp(testDb.db)
    const response = await request(app)
      .post('/membership-invitations/redeem')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .send({ secret })

    expect(response.status).toBe(401)
    expect((response.body as { error: string }).error).toBe('not_signed_in')
  })

  it('redeeming grants the invited role, and the role is real authority — proved by the owner-only invitation list', async () => {
    testDb = createTestDatabase()
    const issuer = seedSignedInCaller(testDb.db)
    const { secret, email } = seedInvitation(testDb.db, issuer, {
      role: 'owner',
    })
    const redeemer = seedAccountWithEmail(testDb.db, email)

    const app = await buildTestApp(testDb.db)

    // Before redemption: an owner-only action refuses this account for
    // `issuer`'s organization entirely.
    const beforeResponse = await request(app)
      .post(
        `/organizations/${issuer.organizationId}/actions/membershipInvitations.list`
      )
      .set('Origin', TEST_PUBLIC_APP_URL)
      .set('Cookie', redeemer.cookieHeader)
      .send({})
    expect(beforeResponse.status).toBe(404)

    const redeemResponse = await request(app)
      .post('/membership-invitations/redeem')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .set('Cookie', redeemer.cookieHeader)
      .send({ secret })

    expect(redeemResponse.status).toBe(200)
    expect(
      (redeemResponse.body as { organizationId: string; role: string })
        .organizationId
    ).toBe(issuer.organizationId)
    expect(
      (redeemResponse.body as { organizationId: string; role: string }).role
    ).toBe('owner')

    // After redemption: the very same owner-only action now succeeds for
    // this account, against this organization — real authority, not merely
    // a row.
    const afterResponse = await request(app)
      .post(
        `/organizations/${issuer.organizationId}/actions/membershipInvitations.list`
      )
      .set('Origin', TEST_PUBLIC_APP_URL)
      .set('Cookie', redeemer.cookieHeader)
      .send({})
    expect(afterResponse.status).toBe(200)
  })

  // ENRL-10: a body-supplied identity must not redirect the grant to
  // anyone else — `z.strictObject` refuses the extra field outright, rather
  // than silently ignoring it.
  it('refuses a request body carrying an accountId, granting nobody anything', async () => {
    testDb = createTestDatabase()
    const issuer = seedSignedInCaller(testDb.db)
    const { secret, email } = seedInvitation(testDb.db, issuer)
    const redeemer = seedAccountWithEmail(testDb.db, email)
    const victim = seedSignedInCaller(testDb.db)

    const app = await buildTestApp(testDb.db)
    const response = await request(app)
      .post('/membership-invitations/redeem')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .set('Cookie', redeemer.cookieHeader)
      .send({ secret, accountId: victim.accountId })

    expect(response.status).toBe(400)
    expect((response.body as { error: string }).error).toBe(
      'action_input_invalid'
    )
    expect(
      memberships.getMembership(
        issuer.organizationId,
        redeemer.accountId,
        testDb.db
      )
    ).toBeUndefined()
    expect(
      memberships.getMembership(
        issuer.organizationId,
        victim.accountId,
        testDb.db
      )
    ).toBeUndefined()
  })

  // ENRL-10: never-issued, revoked, expired, already-redeemed, a
  // wrong-account attempt and an already-a-member account are all refused
  // byte-identically — the same status, the same body, across all six.
  it('every refusal reason produces a byte-identical response', async () => {
    testDb = createTestDatabase()
    const issuer = seedSignedInCaller(testDb.db)

    const { secret: revokedSecret, invitationId: revokedId } = seedInvitation(
      testDb.db,
      issuer
    )
    membershipInvitations.revokeInvitation(
      issuer.organizationId,
      revokedId,
      testDb.db
    )

    const { secret: expiredSecret, email: expiredEmail } = seedInvitation(
      testDb.db,
      issuer,
      { expiresAt: Date.now() - 1000 }
    )

    const { secret: redeemedSecret, email: redeemedEmail } = seedInvitation(
      testDb.db,
      issuer
    )
    const redeemedAccount = seedAccountWithEmail(testDb.db, redeemedEmail)
    const app = await buildTestApp(testDb.db)
    await request(app)
      .post('/membership-invitations/redeem')
      .set('Origin', TEST_PUBLIC_APP_URL)
      .set('Cookie', redeemedAccount.cookieHeader)
      .send({ secret: redeemedSecret })

    const { secret: wrongAccountSecret } = seedInvitation(testDb.db, issuer, {
      email: 'addressed-to-somebody-else@example.edu',
    })
    const wrongAccount = seedAccountWithEmail(
      testDb.db,
      'not-the-invitee@example.edu'
    )

    const { secret: alreadyMemberSecret, email: alreadyMemberEmail } =
      seedInvitation(testDb.db, issuer)
    const alreadyMember = seedAccountWithEmail(testDb.db, alreadyMemberEmail)
    memberships.createMembership(
      issuer.organizationId,
      alreadyMember.accountId,
      'assistant',
      testDb.db
    )

    // One account suffices for the never-issued/revoked/expired cases — all
    // three refuse before this function's own email-match check ever runs
    // (`redeemMembershipInvitation`'s own doc comment: `findLiveInvitationByHash`
    // is the first thing it checks), so which account attempts them makes
    // no difference to the outcome.
    const bystander = seedAccountWithEmail(testDb.db, expiredEmail)

    const cases: { secret: string; cookieHeader: string }[] = [
      { secret: 'never-issued-secret', cookieHeader: bystander.cookieHeader },
      { secret: revokedSecret, cookieHeader: bystander.cookieHeader },
      { secret: expiredSecret, cookieHeader: bystander.cookieHeader },
      // Already-redeemed: the very account that redeemed it, trying again.
      { secret: redeemedSecret, cookieHeader: redeemedAccount.cookieHeader },
      { secret: wrongAccountSecret, cookieHeader: wrongAccount.cookieHeader },
      {
        secret: alreadyMemberSecret,
        cookieHeader: alreadyMember.cookieHeader,
      },
    ]

    const responses = await Promise.all(
      cases.map(({ secret, cookieHeader }) =>
        request(app)
          .post('/membership-invitations/redeem')
          .set('Origin', TEST_PUBLIC_APP_URL)
          .set('Cookie', cookieHeader)
          .send({ secret })
      )
    )

    for (const response of responses) {
      expect(response.status).toBe(404)
      expect(response.body).toEqual({
        error: 'membership_invitation_not_found',
      })
    }
  })
})
