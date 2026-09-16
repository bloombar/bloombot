/**
 * WEB-51 — `normalizeCategoryName` mirrors `@bloombot/db`'s own copy
 * (`packages/db/tests/category-name.test.ts`, BOT-13/PROJ-10): case and
 * every whitespace character are ignored, punctuation is not.
 */

import { describe, expect, it } from 'vitest'

import { normalizeCategoryName } from '../src/category-name.js'

describe('normalizeCategoryName', () => {
  it('matches names that differ only by case', () => {
    expect(normalizeCategoryName('Web Design')).toBe(
      normalizeCategoryName('WEB DESIGN')
    )
  })

  it('matches names that differ only by whitespace, including runs of it', () => {
    expect(normalizeCategoryName('Web Design')).toBe(
      normalizeCategoryName(' web  DESIGN')
    )
    expect(normalizeCategoryName('Web Design')).toBe(
      normalizeCategoryName('WebDesign')
    )
  })

  it('does not match names that differ by punctuation', () => {
    expect(normalizeCategoryName('Web Design')).not.toBe(
      normalizeCategoryName('Web-Design')
    )
  })
})
