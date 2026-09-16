/**
 * WEB-51: `apps/web` duplicates `@bloombot/db`'s own `normalizeCategoryName`
 * as `@bloombot/schemas`'s own copy of the same name — `apps/web` cannot
 * depend on `@bloombot/db` at all (PLAT-2), so the client-side same-course
 * duplicate check and the server's PROJ-3/BOT-13 refusal each carry their
 * own copy of the identical comparison. This package is the one place in
 * the workspace that already depends on both (`package.json`), so it is
 * where a drift between the two would actually be caught — running the same
 * inputs through both and failing the moment they disagree, rather than
 * trusting the two module comments to stay in sync by hand.
 */

import { describe, expect, it } from 'vitest'

import { normalizeCategoryName as dbNormalizeCategoryName } from '@bloombot/db'
import { normalizeCategoryName as schemasNormalizeCategoryName } from '@bloombot/schemas'

describe('normalizeCategoryName: @bloombot/db and @bloombot/schemas agree', () => {
  const inputs = [
    'Web Design',
    'WEB DESIGN',
    ' web  DESIGN ',
    'WebDesign',
    'Web-Design',
    'Web\tDesign\n',
    '',
    '   ',
    'GLOBAL - abc123',
    'global-abc123',
  ]

  it.each(inputs)('normalizes %j identically', (input) => {
    expect(schemasNormalizeCategoryName(input)).toBe(
      dbNormalizeCategoryName(input)
    )
  })
})
