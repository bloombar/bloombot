/**
 * `describePersonLinkOutcome` (LINK-6) — the wording `pages/Connect.tsx`'s
 * assistant form and `pages/DiscordCallback.tsx`'s own preview screen both
 * share. Every `PersonLinkOutcome.kind` gets its own case here, including
 * `already-connected` — reachable in practice whenever a person revisits a
 * connect screen for an identity they have already proven (this file's own
 * `switch` has no `default`, so a kind this test does not cover would be a
 * compile error, not a silently blank string).
 */

import { describe, expect, it } from 'vitest'

import { describePersonLinkOutcome } from '../src/person-link-outcome.js'

describe('describePersonLinkOutcome', () => {
  it('attach — names that the identity is not connected to anyone yet', () => {
    expect(describePersonLinkOutcome({ kind: 'attach' })).toMatch(
      /has not been connected to anyone yet/
    )
  })

  it('already-connected — names that nothing will change', () => {
    expect(describePersonLinkOutcome({ kind: 'already-connected' })).toMatch(
      /already connected to your account.*Nothing will change/s
    )
  })

  it('merge — names that a record with its own history will be merged in, and nothing is lost', () => {
    expect(
      describePersonLinkOutcome({
        kind: 'merge',
        existingPersonId: 'person-1',
      })
    ).toMatch(/merge that record into your account.*Nothing is lost/s)
  })
})
