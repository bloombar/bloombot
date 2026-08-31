import { afterEach, describe, expect, it } from 'vitest'

import { adminEmails, isAdminEmail } from '@bloombot/config'

describe('isAdminEmail (AUTH-4)', () => {
  const original = process.env.ADMIN_EMAILS

  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_EMAILS
    else process.env.ADMIN_EMAILS = original
  })

  it('matches an address in the allowlist', () => {
    process.env.ADMIN_EMAILS = 'dean@example.edu,ta@example.edu'

    expect(isAdminEmail('ta@example.edu')).toBe(true)
  })

  it('rejects an address that is not in the allowlist', () => {
    process.env.ADMIN_EMAILS = 'dean@example.edu'

    expect(isAdminEmail('student@example.edu')).toBe(false)
  })

  it('ignores case on both sides', () => {
    process.env.ADMIN_EMAILS = 'Dean@Example.EDU'

    expect(isAdminEmail('dean@example.edu')).toBe(true)
    expect(isAdminEmail('DEAN@EXAMPLE.EDU')).toBe(true)
  })

  it('ignores surrounding whitespace on both sides', () => {
    process.env.ADMIN_EMAILS = '  dean@example.edu ,  ta@example.edu  '

    expect(isAdminEmail('  ta@example.edu  ')).toBe(true)
  })

  it('treats an empty or unset allowlist as nobody', () => {
    process.env.ADMIN_EMAILS = ''
    expect(isAdminEmail('dean@example.edu')).toBe(false)

    delete process.env.ADMIN_EMAILS
    expect(isAdminEmail('dean@example.edu')).toBe(false)
  })

  it('never matches an empty or missing address', () => {
    process.env.ADMIN_EMAILS = 'dean@example.edu,'

    expect(isAdminEmail('')).toBe(false)
    expect(isAdminEmail('   ')).toBe(false)
    expect(isAdminEmail(null)).toBe(false)
    expect(isAdminEmail(undefined)).toBe(false)
  })

  // This is the assertion that pins AUTH-4. If the allowlist were captured at
  // import — the obvious implementation — this test would fail, because the
  // module was imported at the top of this file, before the value below existed.
  it('reflects a change to ADMIN_EMAILS made after the module was imported', () => {
    process.env.ADMIN_EMAILS = 'first@example.edu'
    expect(isAdminEmail('first@example.edu')).toBe(true)
    expect(isAdminEmail('second@example.edu')).toBe(false)

    // A new administrator is added by editing the environment. No redeploy.
    process.env.ADMIN_EMAILS = 'first@example.edu,second@example.edu'
    expect(isAdminEmail('second@example.edu')).toBe(true)

    // And revoked the same way.
    process.env.ADMIN_EMAILS = 'second@example.edu'
    expect(isAdminEmail('first@example.edu')).toBe(false)
  })
})

describe('adminEmails', () => {
  const original = process.env.ADMIN_EMAILS

  afterEach(() => {
    if (original === undefined) delete process.env.ADMIN_EMAILS
    else process.env.ADMIN_EMAILS = original
  })

  it('normalizes and drops blank entries', () => {
    process.env.ADMIN_EMAILS = ' Dean@Example.edu , ,ta@example.edu,'

    expect(adminEmails()).toEqual(['dean@example.edu', 'ta@example.edu'])
  })
})
