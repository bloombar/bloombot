/**
 * BOT-13/PROJ-10: two category names match when they are equal after
 * lowercasing and removing every whitespace character — leading, trailing
 * and inner, all of it, not merely collapsed to one space. Punctuation is
 * left alone.
 */

import { describe, expect, it } from 'vitest'

import { normalizeCategoryName } from '../src/category-name.js'

describe('normalizeCategoryName (BOT-13/PROJ-10)', () => {
  it('is case-insensitive', () => {
    expect(normalizeCategoryName('WEBDESIGN')).toBe(
      normalizeCategoryName('webdesign')
    )
  })

  it('ignores leading and trailing whitespace', () => {
    expect(normalizeCategoryName(' Web Design ')).toBe(
      normalizeCategoryName('Web Design')
    )
  })

  it('ignores doubled inner whitespace, not just a single space', () => {
    expect(normalizeCategoryName('Web  Design')).toBe(
      normalizeCategoryName('Web Design')
    )
  })

  it('ignores a tab the same as a space', () => {
    expect(normalizeCategoryName('Web\tDesign')).toBe(
      normalizeCategoryName('Web Design')
    )
  })

  it('treats "Web Design" and "WebDesign" as the same name — whitespace is removed, not collapsed', () => {
    expect(normalizeCategoryName('WebDesign')).toBe(
      normalizeCategoryName('Web Design')
    )
  })

  it('does not loosen punctuation — a hyphen is not whitespace', () => {
    expect(normalizeCategoryName('Web-Design')).not.toBe(
      normalizeCategoryName('Web Design')
    )
  })
})
