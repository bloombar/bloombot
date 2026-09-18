/**
 * WEB-65/WEB-52 — `personIdentity`'s own four-tier order, reordered for a
 * heading (`../src/person-identity.ts`'s own module comment, `docs/DECISIONS.md`
 * D-125): a full name, else a Discord display name, else an email, else
 * the bare person id. Cheap-fix 4 (review): every heading test elsewhere in
 * this suite sets only `personDisplayName`, which never exercises the
 * ordering between the other three fields at all — one assertion per tier
 * here, each with every lower-priority field also populated, so a tier
 * winning proves the ordering, not merely that a fallback exists.
 */

import { describe, expect, it } from 'vitest'

import { personIdentity } from '../src/person-identity.js'

const BASE = {
  personId: 'person-1',
  personFirstName: null,
  personLastName: null,
  personEmail: null,
  personDiscordName: null,
} as const

describe('personIdentity (WEB-52/WEB-65)', () => {
  it('a full name wins over a Discord display name, an email and the id', () => {
    expect(
      personIdentity({
        ...BASE,
        personFirstName: 'Priya',
        personLastName: 'Shah',
        personDiscordName: 'PriyaDiscord',
        personEmail: 'priya@example.edu',
      })
    ).toBe('Priya Shah')
  })

  it('a Discord display name wins over an email and the id, when no name is known', () => {
    expect(
      personIdentity({
        ...BASE,
        personDiscordName: 'PriyaDiscord',
        personEmail: 'priya@example.edu',
      })
    ).toBe('PriyaDiscord')
  })

  it('an email wins over the id, when no name or Discord display name is known', () => {
    expect(
      personIdentity({
        ...BASE,
        personEmail: 'priya@example.edu',
      })
    ).toBe('priya@example.edu')
  })

  it('falls back to the bare person id once nothing else is known', () => {
    expect(personIdentity(BASE)).toBe('person-1')
  })
})
