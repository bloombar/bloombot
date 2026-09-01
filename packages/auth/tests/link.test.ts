/**
 * AUTH-2 — the identity-linking rule, in isolation: no database, no
 * network. This is the requirement's own sentence under test: "a Google
 * identity links to an existing account only when the provider asserts the
 * email is verified and it matches; otherwise a new account is created" —
 * and "linking on an unverified email is account takeover" is the failure
 * mode every negative case here exists to rule out.
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
  // to match an existing account must never link to it.
  it('creates a new account when the email matches an existing account but is NOT verified', () => {
    const decision = decideLinkOutcome(
      identity({ email: 'person@example.edu', emailVerified: false }),
      'person@example.edu'
    )
    expect(decision).toEqual({ action: 'create' })
  })

  it('creates a new account when the email is verified but matches no existing account', () => {
    const decision = decideLinkOutcome(
      identity({ email: 'nobody-yet@example.edu', emailVerified: true }),
      undefined
    )
    expect(decision).toEqual({ action: 'create' })
  })

  it('creates a new account when the email is unverified and matches no existing account', () => {
    const decision = decideLinkOutcome(
      identity({ email: 'nobody-yet@example.edu', emailVerified: false }),
      undefined
    )
    expect(decision).toEqual({ action: 'create' })
  })

  it('creates a new account when verified but the existing account has a different email', () => {
    const decision = decideLinkOutcome(
      identity({ email: 'person@example.edu', emailVerified: true }),
      'someone-else@example.edu'
    )
    expect(decision).toEqual({ action: 'create' })
  })
})
