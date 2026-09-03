/**
 * CORE-7/CORE-8 — this package receives `addressAs`/`personIdentifier`
 * already decided by whichever surface called `answerQuestion`
 * (`@bloombot/core`'s `ports.ts` has the fuller "the surface decides how,
 * or whether, to address a person" reasoning, D-70); it must never assemble
 * a surface's own syntax itself, the same "surface-agnostic" rule CORE-4
 * already holds `packages/core` to. Found in review: the guard this rework
 * added to `packages/core/tests/no-vendor-sdk.test.ts` only scanned
 * `packages/core/src` — this package is equally able to hard-code a
 * surface's own token, and it is where `addressAs` and `personIdentifier`
 * actually land (`conversations.ts`'s own `buildSeedText`, `metadata.
 * user_id`), so it gets the identical scan rather than a narrower one. The
 * same shape `no-vendor-hostname.test.ts` already takes for MDL-7 — copied
 * here rather than weakened, and see that file's own comment for why.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url))

/**
 * Every `.ts` file under `SRC_DIR`, at any depth — the same recursive walk
 * `no-vendor-hostname.test.ts`/`no-vendor-sdk.test.ts` use, for the same
 * reason: a future `src/adapters/foo.ts` must be scanned too, not just
 * today's flat layout.
 */
function listSourceFilesRecursively(dir: string, prefix = ''): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(
        ...listSourceFilesRecursively(`${dir}/${entry.name}`, relativePath)
      )
    } else if (entry.name.endsWith('.ts')) {
      files.push(relativePath)
    }
  }
  return files
}

describe('packages/openai contains no hardcoded surface-specific address syntax (CORE-7)', () => {
  const files = listSourceFilesRecursively(SRC_DIR)

  it('found at least one source file to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  // A known, accepted limitation (this rework's own review round named it,
  // and `no-vendor-sdk.test.ts`'s own comment on the identical guard there
  // says the same): this only catches the literal token, not an obfuscated
  // equivalent built by concatenation. The actual backstop for the defect
  // class is behavioural — `packages/core/tests/answer.test.ts`'s own
  // `EchoingModelClient` block, and `packages/openai/tests/client.test.ts`'s
  // own "addressAs and personIdentifier are sourced independently" case —
  // not this scan; this exists for the cheap, fast case only.
  for (const file of files) {
    it(`${file} contains no Discord-style mention token`, () => {
      const source = readFileSync(`${SRC_DIR}/${file}`, 'utf8')
      expect(source, `${file} contains a literal "<@"`).not.toContain('<@')
    })
  }
})
