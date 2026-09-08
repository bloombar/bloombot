/**
 * The importer writes only through `@bloombot/db`'s repos, never with SQL of
 * its own against the platform tables — the same shape
 * `packages/db/tests/conversations.test.ts`'s no-delete test takes: read the
 * actual source rather than trust a convention nobody checks.
 *
 * `read-legacy.ts` is exempt: reading the *legacy* database with raw SQL is
 * expected (it is the only file in this package that speaks that schema —
 * see its module comment) and must not trip this.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url))
const EXEMPT_FILES = new Set(['read-legacy.ts'])

const forbiddenPatterns = [
  /\bdb\s*\.\s*insert\(/,
  /\bdb\s*\.\s*update\(/,
  /\btx\s*\.\s*insert\(/,
  /\btx\s*\.\s*update\(/,
  /insert\s+into\s+`?(organizations|projects|courses|course_categories|course_channels|people|person_identities|conversations|messages|usage_counters)`?/i,
  /update\s+`?(organizations|projects|courses|course_categories|course_channels|people|person_identities|conversations|messages|usage_counters)`?\s+set/i,
]

describe('packages/legacy-import writes only through @bloombot/db repos', () => {
  const files = readdirSync(SRC_DIR).filter((name) => name.endsWith('.ts'))

  it('found at least one non-exempt source file to check', () => {
    expect(files.filter((f) => !EXEMPT_FILES.has(f)).length).toBeGreaterThan(0)
  })

  for (const file of files) {
    if (EXEMPT_FILES.has(file)) continue
    it(`${file} contains no raw write against a platform table`, () => {
      const source = readFileSync(`${SRC_DIR}/${file}`, 'utf8')
      for (const pattern of forbiddenPatterns) {
        expect(source, `${file} matched ${pattern}`).not.toMatch(pattern)
      }
    })
  }

  it('read-legacy.ts is exempt because it reads the legacy database, not the platform one', () => {
    const source = readFileSync(`${SRC_DIR}/read-legacy.ts`, 'utf8')
    // Confirms the file this test exempts still exists and still does what
    // the exemption is for — a stale exemption for a file that changed
    // shape underneath it would otherwise go unnoticed.
    expect(source).toMatch(/select/i)
  })
})
