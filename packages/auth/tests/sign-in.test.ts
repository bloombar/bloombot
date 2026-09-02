/**
 * The sign-in flows, end to end against a real (throwaway) database:
 * AUTH-1's redemption, AUTH-2's Google linking rule, and TEN-1's atomic
 * "account, personal organization and membership together, or none of
 * them".
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { accounts, organizations, people, schema } from '@bloombot/db'

import { RecordingEmailSender } from '../src/email.js'
import type { GoogleIdentity } from '../src/link.js'
import {
  redeemSignInLink,
  requestSignInLink,
  signInWithGoogle,
} from '../src/sign-in.js'
import { validateSession } from '../src/sessions.js'
import { consumeSignInToken, issueSignInToken } from '../src/tokens.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('redeemSignInLink (AUTH-1, TEN-1)', () => {
  it('creates the account, its personal organization and its membership, atomically, on a first-time sign-in', () => {
    testDb = createTestDatabase()
    const { token } = issueSignInToken('new.instructor@example.edu', testDb.db)

    const result = redeemSignInLink(token, testDb.db)

    expect(result).toBeDefined()
    expect(result?.createdAccount).toBe(true)
    expect(result?.account.email).toBe('new.instructor@example.edu')

    // A membership row exists for this account, with the `owner` role
    // TEN-1's personal organization grants a first-time sign-in.
    const membershipRows = testDb.db.select().from(schema.memberships).all()
    expect(membershipRows).toHaveLength(1)
    expect(membershipRows[0]).toMatchObject({
      accountId: result?.account.id,
      role: 'owner',
    })

    // And the organization it names is a fresh, personal one.
    const organizationRow = organizations.getOrganizationById(
      membershipRows[0]!.organizationId,
      testDb.db
    )
    expect(organizationRow).toMatchObject({ isPersonal: true })
  })

  // WEB-10/LINK-1 rework: a signed-in web caller is the account — no
  // separate "connect your web account" step exists or is needed, so this
  // person is created and connected the moment the account itself is,
  // through the real `connectIdentity` path, not a raw column write.
  it("connects the account's own web person at creation, through the real connectIdentity path — not a raw connectedAt write", () => {
    testDb = createTestDatabase()
    const { token } = issueSignInToken('new.instructor@example.edu', testDb.db)

    const result = redeemSignInLink(token, testDb.db)
    expect(result).toBeDefined()

    const membershipRows = testDb.db.select().from(schema.memberships).all()
    const organizationId = membershipRows[0]!.organizationId

    const person = people.resolveIdentity(
      organizationId,
      { surface: 'web', externalId: result!.account.id },
      testDb.db
    )
    expect(person).toBeDefined()
    // Connected immediately (LINK-1's own gate) — `answerQuestion` declines
    // any person whose `connectedAt` is still `null`, and a web-authenticated
    // account has already proven itself by signing in (this file's own new
    // `createConnectedWebPerson` doc comment).
    expect(person?.connectedAt).not.toBeNull()
    // Exactly one person for this organization — creation is not doubled up
    // with some other write this test would otherwise miss.
    expect(people.listPeople(organizationId, testDb.db)).toHaveLength(1)
  })

  it('does not create a second account for a returning sign-in', () => {
    testDb = createTestDatabase()
    const first = issueSignInToken('returning@example.edu', testDb.db)
    const firstResult = redeemSignInLink(first.token, testDb.db)

    const second = issueSignInToken('returning@example.edu', testDb.db)
    const secondResult = redeemSignInLink(second.token, testDb.db)

    expect(secondResult?.createdAccount).toBe(false)
    expect(secondResult?.account.id).toBe(firstResult?.account.id)
    expect(testDb.db.select().from(schema.accounts).all()).toHaveLength(1)
  })

  it('does not create a second web person for a returning sign-in', () => {
    testDb = createTestDatabase()
    const first = issueSignInToken('returning-person@example.edu', testDb.db)
    const firstResult = redeemSignInLink(first.token, testDb.db)
    const membershipRows = testDb.db.select().from(schema.memberships).all()
    const organizationId = membershipRows[0]!.organizationId

    const second = issueSignInToken('returning-person@example.edu', testDb.db)
    redeemSignInLink(second.token, testDb.db)

    expect(people.listPeople(organizationId, testDb.db)).toHaveLength(1)
    const person = people.resolveIdentity(
      organizationId,
      { surface: 'web', externalId: firstResult!.account.id },
      testDb.db
    )
    expect(person).toBeDefined()
  })

  // LINK-9's own healing path — reproduced against an account shaped the
  // way every account created before this rework shipped actually is:
  // organization, account and membership, written directly (bypassing
  // `sign-in.ts` entirely, the same way a pre-rework `createConnectedWebPerson`
  // simply never ran for it), with no person at all. Left alone, this
  // account is refused `chat_not_connected` permanently, with no
  // configuration and no later sign-in that fixes it — this proves a later
  // sign-in *does* fix it.
  it('heals a pre-existing account with no web person at all, on its next sign-in', () => {
    testDb = createTestDatabase()
    const organizationId = crypto.randomUUID()
    organizations.createOrganization(
      organizationId,
      { name: 'Pre-rework Org', isPersonal: true },
      testDb.db
    )
    const preExisting = accounts.createAccount(
      organizationId,
      {
        email: 'pre-rework@example.edu',
        displayName: 'Pre Rework',
        role: 'owner',
      },
      testDb.db
    )
    // Exactly the state a reviewer reproduced: no person for this account
    // in its own organization, at all.
    expect(people.listPeople(organizationId, testDb.db)).toHaveLength(0)

    const { token } = issueSignInToken('pre-rework@example.edu', testDb.db)
    const result = redeemSignInLink(token, testDb.db)

    expect(result?.createdAccount).toBe(false)
    expect(result?.account.id).toBe(preExisting.id)
    const person = people.resolveIdentity(
      organizationId,
      { surface: 'web', externalId: preExisting.id },
      testDb.db
    )
    expect(person).toBeDefined()
    expect(person?.connectedAt).not.toBeNull()
  })

  it('a second sign-in for an already-healed account does not create a second person', () => {
    testDb = createTestDatabase()
    const organizationId = crypto.randomUUID()
    organizations.createOrganization(
      organizationId,
      { name: 'Pre-rework Org', isPersonal: true },
      testDb.db
    )
    accounts.createAccount(
      organizationId,
      {
        email: 'heal-twice@example.edu',
        displayName: 'Heal Twice',
        role: 'owner',
      },
      testDb.db
    )

    const first = issueSignInToken('heal-twice@example.edu', testDb.db)
    redeemSignInLink(first.token, testDb.db)
    const second = issueSignInToken('heal-twice@example.edu', testDb.db)
    redeemSignInLink(second.token, testDb.db)

    expect(people.listPeople(organizationId, testDb.db)).toHaveLength(1)
  })

  // Finding 2 of the AUTH-1..4 rework, belt-and-braces half: redeeming a
  // link is proof of control of the address, so a returning sign-in must
  // revoke whatever sessions the account already held — including one an
  // attacker may hold on an account they reached before the real owner
  // ever signed in (an unverified Google identity that used to be able to
  // `create` an account for an address it did not control).
  it('revokes the account other sessions when a returning sign-in redeems a link', () => {
    testDb = createTestDatabase()
    const first = issueSignInToken('returning@example.edu', testDb.db)
    const firstResult = redeemSignInLink(first.token, testDb.db)
    const oldToken = firstResult!.session.token

    const second = issueSignInToken('returning@example.edu', testDb.db)
    const secondResult = redeemSignInLink(second.token, testDb.db)

    expect(secondResult?.createdAccount).toBe(false)
    // The session from the earlier redemption no longer validates …
    expect(validateSession(oldToken, testDb.db)).toBeUndefined()
    // … but the new one from this redemption does.
    expect(
      validateSession(secondResult!.session.token, testDb.db)
    ).toMatchObject({ accountId: secondResult?.account.id })
  })

  // Finding 3 of the AUTH-1..4 rework: a disabled account must refuse
  // sign-in, not merely have its existing sessions stop working.
  it('refuses to sign in a disabled account, but still consumes the token', () => {
    testDb = createTestDatabase()
    const { token: firstToken } = issueSignInToken(
      'suspended@example.edu',
      testDb.db
    )
    const firstResult = redeemSignInLink(firstToken, testDb.db)
    accounts.disableAccount(firstResult!.account.id, testDb.db)

    const { token: secondToken } = issueSignInToken(
      'suspended@example.edu',
      testDb.db
    )
    const result = redeemSignInLink(secondToken, testDb.db)

    expect(result).toBeUndefined()
    // The token was legitimately issued and redeemed — burned either way,
    // not left replayable once the account might be re-enabled.
    expect(consumeSignInToken(secondToken, testDb.db)).toBeUndefined()
  })

  it('returns undefined for an invalid token without creating anything', () => {
    testDb = createTestDatabase()

    const result = redeemSignInLink('never-issued', testDb.db)

    expect(result).toBeUndefined()
    expect(testDb.db.select().from(schema.accounts).all()).toHaveLength(0)
  })

  // TEN-1: "a failure part-way leaves none of the three [account,
  // organization, membership]." Forces the failure the same way
  // `packages/db`'s own `accounts.test.ts` does for `createAccount` alone —
  // here the id `crypto.randomUUID()` hands back for the *account* row is
  // made to collide with an already-existing, unrelated account, so the
  // account insert fails on its primary key after the organization insert
  // ahead of it has already succeeded. If the three writes were not one
  // transaction, the organization row would survive this; asserting it does
  // not is the actual proof.
  it('a failure creating the account rolls back the organization it already created', () => {
    testDb = createTestDatabase()
    const collidingAccountId = accounts.createAccount(
      organizations.createOrganization(
        crypto.randomUUID(),
        { name: 'Unrelated', isPersonal: false },
        testDb.db
      ).id,
      {
        email: 'unrelated@example.edu',
        displayName: 'Unrelated',
        role: 'owner',
      },
      testDb.db
    ).id

    const { token } = issueSignInToken('first-timer@example.edu', testDb.db)

    const orgIdForThisSignIn = crypto.randomUUID()
    const randomUUIDSpy = vi
      .spyOn(globalThis.crypto, 'randomUUID')
      // 1st call: the personal organization's id — succeeds.
      .mockReturnValueOnce(
        orgIdForThisSignIn as `${string}-${string}-${string}-${string}-${string}`
      )
      // 2nd call: the account's id — collides with the account seeded above,
      // so this insert fails its primary key.
      .mockReturnValueOnce(
        collidingAccountId as `${string}-${string}-${string}-${string}-${string}`
      )

    expect(() => redeemSignInLink(token, testDb.db)).toThrow()
    randomUUIDSpy.mockRestore()

    // The organization created just before the failing account insert must
    // not have survived — same transaction, same rollback.
    expect(
      organizations.getOrganizationById(orgIdForThisSignIn, testDb.db)
    ).toBeUndefined()
    // Nor a second membership under it.
    expect(
      testDb.db
        .select()
        .from(schema.memberships)
        .all()
        .filter((row) => row.organizationId === orgIdForThisSignIn)
    ).toHaveLength(0)
    // The token itself must not have been left "used" by a sign-in that
    // never completed — AUTH-1's own redemption is inside the same rolled-
    // back transaction.
    const tokenRow = testDb.db.select().from(schema.signInTokens).get()
    expect(tokenRow?.usedAt).toBeNull()
  })
})

function verifiedGoogleIdentity(
  overrides: Partial<GoogleIdentity> = {}
): GoogleIdentity {
  return {
    subject: 'google-subject-1',
    email: 'person@example.edu',
    emailVerified: true,
    ...overrides,
  }
}

describe('signInWithGoogle (AUTH-2)', () => {
  it('links to an existing account when the email is verified and matches', () => {
    testDb = createTestDatabase()
    const { token } = issueSignInToken('person@example.edu', testDb.db)
    const existing = redeemSignInLink(token, testDb.db)

    const result = signInWithGoogle(
      verifiedGoogleIdentity({ email: 'person@example.edu' }),
      testDb.db
    )

    expect(result?.createdAccount).toBe(false)
    expect(result?.account.id).toBe(existing?.account.id)
    expect(testDb.db.select().from(schema.accounts).all()).toHaveLength(1)
  })

  // Must-fix 2 of the API-1..6 rework: `redeemSignInLink` already rotates a
  // returning sign-in's other sessions; `signInWithGoogle`'s `link` branch
  // did not, so a stolen cookie survived the victim signing back in through
  // Google. A successful Google sign-in is proof of control of the address,
  // the same proof redeeming an emailed link is.
  it('rotates the session when linking to an existing account: the old token stops validating', () => {
    testDb = createTestDatabase()
    const { token } = issueSignInToken('person@example.edu', testDb.db)
    const existing = redeemSignInLink(token, testDb.db)
    const oldToken = existing!.session.token
    expect(validateSession(oldToken, testDb.db)).toBeDefined()

    const result = signInWithGoogle(
      verifiedGoogleIdentity({ email: 'person@example.edu' }),
      testDb.db
    )

    expect(result?.account.id).toBe(existing?.account.id)
    // The session from the earlier redemption no longer validates …
    expect(validateSession(oldToken, testDb.db)).toBeUndefined()
    // … but the new one from this Google sign-in does.
    expect(validateSession(result!.session.token, testDb.db)).toMatchObject({
      accountId: existing?.account.id,
    })
  })

  it('creates a new account when the email is verified but matches nobody', () => {
    testDb = createTestDatabase()

    const result = signInWithGoogle(
      verifiedGoogleIdentity({ email: 'brand-new@example.edu' }),
      testDb.db
    )

    expect(result?.createdAccount).toBe(true)
    expect(result?.account.email).toBe('brand-new@example.edu')
    const membershipRows = testDb.db.select().from(schema.memberships).all()
    expect(membershipRows).toHaveLength(1)
  })

  it("connects the account's own web person at creation (tryCreateAccountForEmail's own branch)", () => {
    testDb = createTestDatabase()

    const result = signInWithGoogle(
      verifiedGoogleIdentity({ email: 'brand-new-connected@example.edu' }),
      testDb.db
    )
    expect(result?.createdAccount).toBe(true)
    const membershipRows = testDb.db.select().from(schema.memberships).all()
    const organizationId = membershipRows[0]!.organizationId

    const person = people.resolveIdentity(
      organizationId,
      { surface: 'web', externalId: result!.account.id },
      testDb.db
    )
    expect(person).toBeDefined()
    expect(person?.connectedAt).not.toBeNull()
  })

  // AUTH-2's own attack sentence, exercised end to end: an unverified email
  // that matches an existing account must never sign the caller into that
  // account. Refusing outright (finding 2 of the AUTH-1..4 rework) rather
  // than falling back to creating a second account — the documented,
  // deliberate outcome here is a clean refusal, not a linked session, not a
  // second account, and not a crash. See docs/DECISIONS.md.
  it('refuses to sign in — and never links — when the email matches an existing account but is not verified', () => {
    testDb = createTestDatabase()
    const { token } = issueSignInToken('victim@example.edu', testDb.db)
    const victim = redeemSignInLink(token, testDb.db)

    const result = signInWithGoogle(
      verifiedGoogleIdentity({
        email: 'victim@example.edu',
        emailVerified: false,
      }),
      testDb.db
    )

    expect(result).toBeUndefined()
    // The victim's account is untouched: still exactly one account, one
    // session (the one from the legitimate redemption above) — the attempt
    // above created neither a second account nor a session for the first.
    expect(testDb.db.select().from(schema.accounts).all()).toHaveLength(1)
    const sessionRows = testDb.db.select().from(schema.sessions).all()
    expect(sessionRows).toHaveLength(1)
    expect(sessionRows[0]?.accountId).toBe(victim?.account.id)
  })

  // Finding 2's own core case, the one no existing test covered: an
  // unverified email matching *nobody yet* must not create an account
  // either. Before the fix, this is the pre-registration takeover — an
  // attacker asserting a victim's real address, before the victim has ever
  // signed in themselves, walks away holding that account.
  it('refuses to sign in — and never creates an account — for an unverified email that matches nobody yet', () => {
    testDb = createTestDatabase()

    const result = signInWithGoogle(
      verifiedGoogleIdentity({
        email: 'not-yet-registered@example.edu',
        emailVerified: false,
      }),
      testDb.db
    )

    expect(result).toBeUndefined()
    expect(testDb.db.select().from(schema.accounts).all()).toHaveLength(0)
    expect(testDb.db.select().from(schema.sessions).all()).toHaveLength(0)

    // The real owner, signing in for the first time immediately afterward,
    // must get a brand-new account — not one an attacker already holds.
    const { token } = issueSignInToken(
      'not-yet-registered@example.edu',
      testDb.db
    )
    const legitimate = redeemSignInLink(token, testDb.db)
    expect(legitimate?.createdAccount).toBe(true)
  })

  // Finding 3 of the AUTH-1..4 rework: a disabled account must refuse to
  // link, even to a verified, matching Google identity.
  it('refuses to sign in a disabled account, even with a verified matching identity', () => {
    testDb = createTestDatabase()
    const { token } = issueSignInToken('suspended@example.edu', testDb.db)
    const victim = redeemSignInLink(token, testDb.db)
    accounts.disableAccount(victim!.account.id, testDb.db)

    const result = signInWithGoogle(
      verifiedGoogleIdentity({ email: 'suspended@example.edu' }),
      testDb.db
    )

    expect(result).toBeUndefined()
  })
})

describe('requestSignInLink (AUTH-1)', () => {
  // Finding 4 of the AUTH-1..4 rework: `email.ts`'s own comment says this
  // package sends a sign-in link through the mail port — this is the
  // function that actually does it.
  it('issues a token and sends it through the mail port, never returning the plaintext itself', async () => {
    testDb = createTestDatabase()
    const emailSender = new RecordingEmailSender()

    const result = await requestSignInLink('student@example.edu', {
      db: testDb.db,
      emailSender,
      buildLink: (token) => `https://app.bloombot.example/sign-in/${token}`,
    })

    expect(result).toBeUndefined()
    expect(emailSender.sent).toHaveLength(1)
    expect(emailSender.sent[0]?.to).toBe('student@example.edu')
    expect(emailSender.sent[0]?.body).toContain(
      'https://app.bloombot.example/sign-in/'
    )

    // The token in the email actually redeems — this is not a fabricated
    // link, it is the one `issueSignInToken` wrote a hash of.
    const sentLink = emailSender.sent[0]?.body ?? ''
    const token = sentLink.split('/sign-in/')[1]?.trim()
    expect(token).toBeDefined()
    expect(redeemSignInLink(token!, testDb.db)).toBeDefined()
  })

  // "Also worth doing" of the API-1..6 rework: `/auth/request-link`
  // (`apps/api`) is unauthenticated and unthrottled, so without this a
  // single address is an unbounded mail-send and row-insert. The response
  // must stay silent either way — AUTH-1's own "always the same response
  // whether or not the address has an account" — so this is proven by what
  // was (not) written and sent, not by a different return value.
  it('declines to issue a second token, and to send a second email, while an earlier one is still outstanding', async () => {
    testDb = createTestDatabase()
    const emailSender = new RecordingEmailSender()
    const deps = {
      db: testDb.db,
      emailSender,
      buildLink: (token: string) =>
        `https://app.bloombot.example/sign-in/${token}`,
    }

    await requestSignInLink('flooded@example.edu', deps)
    await requestSignInLink('flooded@example.edu', deps)
    await requestSignInLink('flooded@example.edu', deps)

    expect(emailSender.sent).toHaveLength(1)
    expect(
      testDb.db
        .select()
        .from(schema.signInTokens)
        .all()
        .filter((row) => row.email === 'flooded@example.edu')
    ).toHaveLength(1)
  })

  it('issues a new token again once the earlier one has been redeemed', async () => {
    testDb = createTestDatabase()
    const emailSender = new RecordingEmailSender()
    const deps = {
      db: testDb.db,
      emailSender,
      buildLink: (token: string) =>
        `https://app.bloombot.example/sign-in/${token}`,
    }

    await requestSignInLink('returning-requester@example.edu', deps)
    const firstLink = emailSender.sent[0]!.body
    const firstToken = firstLink.split('/sign-in/')[1]!.trim()
    redeemSignInLink(firstToken, testDb.db)

    await requestSignInLink('returning-requester@example.edu', deps)

    expect(emailSender.sent).toHaveLength(2)
  })
})
