/**
 * CORE-4: the core depends on `ModelClient` (`src/ports.ts`) alone, never on
 * a vendor SDK. Read the actual source rather than trust a convention nobody
 * checks — the same shape `packages/legacy-import/tests/no-raw-sql.test.ts`
 * takes for "writes only through the repos".
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url))

// Package names (or import path fragments) a vendor SDK would appear under.
// `openai`, Discord's `discord.js`, and any `@discordjs/*` scoped package —
// the two vendors named in the brief as "the next two slices".
const forbiddenPatterns = [
  /from\s+['"]openai['"]/,
  /from\s+['"]discord\.js['"]/,
  /from\s+['"]@discordjs\//,
  /require\(\s*['"]openai['"]\s*\)/,
  /require\(\s*['"]discord\.js['"]\s*\)/,
]

describe('packages/core imports no vendor SDK (CORE-4)', () => {
  const files = readdirSync(SRC_DIR).filter((name) => name.endsWith('.ts'))

  it('found at least one source file to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`${file} imports no vendor SDK`, () => {
      const source = readFileSync(`${SRC_DIR}/${file}`, 'utf8')
      for (const pattern of forbiddenPatterns) {
        expect(source, `${file} matched ${pattern}`).not.toMatch(pattern)
      }
    })
  }

  it('ports.ts declares the model port this package depends on instead', () => {
    const source = readFileSync(`${SRC_DIR}/ports.ts`, 'utf8')
    expect(source).toMatch(/interface ModelClient/)
  })
})
