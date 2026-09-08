/**
 * AUTH-4 — the platform-administrator check follows the environment on
 * every call, with no restart, and there is no exported function anywhere
 * in this package (or `@bloombot/db`'s schema) that grants it.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { isPlatformAdministrator } from '../src/admin.js'

describe('isPlatformAdministrator (AUTH-4)', () => {
  const original = process.env.ADMIN_EMAILS

  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_EMAILS
    else process.env.ADMIN_EMAILS = original
  })

  it('matches an address on the allowlist', () => {
    process.env.ADMIN_EMAILS = 'dean@example.edu'
    expect(isPlatformAdministrator('dean@example.edu')).toBe(true)
  })

  it('rejects an address not on the allowlist', () => {
    process.env.ADMIN_EMAILS = 'dean@example.edu'
    expect(isPlatformAdministrator('student@example.edu')).toBe(false)
  })

  // The requirement's own text: "read on every check rather than captured
  // at startup, so adding or removing one takes effect without a
  // deployment." `isPlatformAdministrator` was already imported (and, by
  // extension, `@bloombot/config` behind it) at the top of this file, before
  // the value asserted below existed — if the allowlist were captured at
  // import time this test would fail.
  it('reflects a change to ADMIN_EMAILS made after this module was imported, with no restart', () => {
    process.env.ADMIN_EMAILS = 'first@example.edu'
    expect(isPlatformAdministrator('second@example.edu')).toBe(false)

    process.env.ADMIN_EMAILS = 'first@example.edu,second@example.edu'
    expect(isPlatformAdministrator('second@example.edu')).toBe(true)

    process.env.ADMIN_EMAILS = 'second@example.edu'
    expect(isPlatformAdministrator('first@example.edu')).toBe(false)
  })

  it('treats an empty or unset allowlist as nobody', () => {
    process.env.ADMIN_EMAILS = ''
    expect(isPlatformAdministrator('dean@example.edu')).toBe(false)

    delete process.env.ADMIN_EMAILS
    expect(isPlatformAdministrator('dean@example.edu')).toBe(false)
  })

  // "It is never a self-granted role or a database flag." Nothing exported
  // from this package writes to ADMIN_EMAILS or to any database table — this
  // test asserts the module's own exported surface has no such function, so
  // a future addition of one is a visible, deliberate change to this file
  // rather than a silent one.
  it('exports no function that could grant the role', async () => {
    const adminModule = await import('../src/admin.js')
    const exportedNames = Object.keys(adminModule)
    expect(exportedNames).toEqual(['isPlatformAdministrator'])
  })
})
