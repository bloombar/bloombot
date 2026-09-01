import { describe, expect, it } from 'vitest'

import { administersGuild } from '../src/permissions.js'

describe('administersGuild', () => {
  it('is true when owner is true, regardless of permissions', () => {
    expect(
      administersGuild({ id: '1', name: 'G', owner: true, permissions: '0' })
    ).toBe(true)
  })

  it('is true when permissions carries the MANAGE_GUILD bit (0x20)', () => {
    expect(
      administersGuild({ id: '1', name: 'G', owner: false, permissions: '32' })
    ).toBe(true)
    // MANAGE_GUILD (32) plus other bits set alongside it.
    expect(
      administersGuild({ id: '1', name: 'G', owner: false, permissions: '40' })
    ).toBe(true)
  })

  it('is false when neither owner nor MANAGE_GUILD is set', () => {
    expect(
      administersGuild({ id: '1', name: 'G', owner: false, permissions: '8' })
    ).toBe(false)
  })

  it('is false when permissions is absent', () => {
    expect(administersGuild({ id: '1', name: 'G', owner: false })).toBe(false)
  })

  it('is false, not thrown, for a non-numeric permissions value', () => {
    expect(
      administersGuild({
        id: '1',
        name: 'G',
        owner: false,
        permissions: 'not-a-number',
      })
    ).toBe(false)
  })

  // A permission set with bits set above JavaScript's 32-bit bitwise range —
  // proving this reads the MANAGE_GUILD bit correctly via BigInt rather than
  // truncating it away with a plain `Number(...) & 0x20`.
  it('correctly reads MANAGE_GUILD out of a permission integer larger than 32 bits', () => {
    const withManageGuild = ((1n << 41n) | 0x20n).toString()
    const withoutManageGuild = (1n << 41n).toString()

    expect(
      administersGuild({
        id: '1',
        name: 'G',
        owner: false,
        permissions: withManageGuild,
      })
    ).toBe(true)
    expect(
      administersGuild({
        id: '1',
        name: 'G',
        owner: false,
        permissions: withoutManageGuild,
      })
    ).toBe(false)
  })
})
