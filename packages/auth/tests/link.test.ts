/**
 * AUTH-2 — the identity-linking rule, in isolation: no database, no
 * network. This is the requirement's own sentence under test: a verified,
 * matching identity links; a verified identity matching nobody yet creates
 * an account; an *unverified* identity is refused outright, whether or not
 * it matches an existing account — "linking on an unverified email is
 * account takeover, and so is creating an account from one" is the failure
 * mode every negative case here exists to rule out (finding 2 of the
 * AUTH-1..4 rework tightened the unverified-and-matches-nobody case from
 * "creates a new account" to "rejects"; see docs/DECISIONS.md D-19).
 */

import { describe, expect, it } from 'vitest'

import { decideLinkOutcome, type GoogleIdentity } from '../src/link.js'

function identity(overrides: Partial<GoogleIdentity> = {}): GoogleIdentity {
  return {
    subject: 'google-subject-1',
    email: 'person@example.edu',
    emailVerified: true,
    ...overrides,
  }
}

describe('decideLinkOutcome (AUTH-2)', () => {
  it('links when the email is verified and matches an existing account', () => {
    const decision = decideLinkOutcome(
      identity({ email: 'person@example.edu', emailVerified: true }),
      'person@example.edu'
    )
    expect(decision).toEqual({ action: 'link' })
  })

  it('matches case-insensitively, the same way accounts.ts stores email', () => {
    const decision = decideLinkOutcome(
      identity({ email: 'Person@Example.EDU', emailVerified: true }),
      'person@example.edu'
    )
    expect(decision).toEqual({ action: 'link' })
  })

  // The requirement's own attack sentence: an unverified email that happens
  // to match an existing account must never link to it — and, since finding
  // 2 of the AUTH-1..4 rework, must not fall back to creating a second
  // account either. An unverified assertion proves nothing, so it must not
  // reach an account at all.
  it('rejects — does not create, does not link — when the email matches an existing account but is NOT verified', () => {
    const decision = decideLinkOutcome(
      identity({ email: 'person@example.edu', emailVerified: false }),
      'person@example.edu'
    )
    expect(decision).toEqual({ action: 'reject' })
  })

  it('creates a new account when the email is verified but matches no existing account', () => {
    const decision = decideLinkOutcome(
      identity({ email: 'nobody-yet@example.edu', emailVerified: true }),
      undefined
    )
    expect(decision).toEqual({ action: 'create' })
  })

  // Finding 2's own pre-registration case: an unverified email that matches
  // *nobody yet* must also be rejected, not created — otherwise an attacker
  // asserting a victim's real address before the victim ever signs in
  // themselves gets to hold that account first.
  it('rejects — does not create — when the email is unverified and matches no existing account', () => {
    const decision = decideLinkOutcome(
      identity({ email: 'nobody-yet@example.edu', emailVerified: false }),
      undefined
    )
    expect(decision).toEqual({ action: 'reject' })
  })

  it('creates a new account when verified but the existing account has a different email', () => {
    const decision = decideLinkOutcome(
      identity({ email: 'person@example.edu', emailVerified: true }),
      'someone-else@example.edu'
    )
    expect(decision).toEqual({ action: 'create' })
  })
})
