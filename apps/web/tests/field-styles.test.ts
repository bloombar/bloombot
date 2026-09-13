/**
 * WEB-48: pins `textInputClasses`'s mobile-safe font size. iOS Safari zooms
 * the whole page in whenever a focused input's font-size is under 16px, and
 * never zooms back out — that is the "sometimes zoomed in, sometimes not"
 * the field report described, since it only happens on screens with a form.
 * `text-sm` alone (14px, unconditionally) is exactly that trap; this test
 * fails against the pre-fix token and only passes once the class list
 * carries a mobile-first `text-base` (16px) that narrows back to `text-sm`
 * at the `sm` breakpoint and up, which is what keeps the desktop panel's
 * own look unchanged.
 */

import { describe, expect, it } from 'vitest'

import { textInputClasses } from '../src/components/fieldStyles.js'

describe('textInputClasses (WEB-48)', () => {
  it('is at least 16px on a phone, so a focused input never triggers an automatic zoom', () => {
    const classes = textInputClasses.split(/\s+/)
    expect(classes).toContain('text-base')
  })

  it('narrows to the existing 14px only at the sm breakpoint and up, so desktop is unchanged', () => {
    const classes = textInputClasses.split(/\s+/)
    expect(classes).toContain('sm:text-sm')
    // Guards against a bare, breakpoint-less `text-sm` sneaking back in
    // alongside `text-base` — Tailwind would apply whichever comes last in
    // the generated stylesheet, which is not a phone-vs-desktop distinction
    // at all.
    expect(classes).not.toContain('text-sm')
  })
})
