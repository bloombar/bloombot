/**
 * MDL-7: "the provider's base URL is configuration, never a literal in a
 * client". Read the actual source rather than trust a convention nobody
 * checks — the same shape `packages/core/tests/no-vendor-sdk.test.ts` takes
 * for "no vendor SDK import", recursive and including a `package.json`
 * check, copied here rather than weakened.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url))
const PACKAGE_JSON_PATH = fileURLToPath(
  new URL('../package.json', import.meta.url)
)

// Every literal hostname (or fragment of one) a hardcoded call to the real
// service could take — `api.openai.com` is the one named in the brief as
// "the defect MDL-7 exists to prevent", `openai.com` alone catches a
// scheme-less or subdomain variant of the same mistake.
const FORBIDDEN_HOSTNAME_PATTERNS = [/api\.openai\.com/, /openai\.com/]

/**
 * Every `.ts` file under `SRC_DIR`, at any depth — the same recursive walk
 * `no-vendor-sdk.test.ts` uses, for the same reason: a future
 * `src/adapters/foo.ts` must be scanned too, not just today's flat layout.
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

describe('packages/openai hardcodes no provider hostname (MDL-7)', () => {
  const files = listSourceFilesRecursively(SRC_DIR)

  it('found at least one source file to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`${file} contains no literal OpenAI hostname`, () => {
      const source = readFileSync(`${SRC_DIR}/${file}`, 'utf8')
      for (const pattern of FORBIDDEN_HOSTNAME_PATTERNS) {
        expect(source, `${file} matched ${pattern}`).not.toMatch(pattern)
      }
    })
  }

  it('client.ts reads the base URL from CONFIG.OPENAI_BASE_URL rather than defaulting it itself', () => {
    const source = readFileSync(`${SRC_DIR}/client.ts`, 'utf8')
    expect(source).toMatch(/CONFIG\.OPENAI_BASE_URL/)
  })

  // The base URL's real default (`https://api.openai.com/v1`) lives in
  // exactly one place, `@bloombot/config`'s `env.ts` (QA-2) — this package
  // depends on it for that default rather than declaring one of its own.
  it('package.json depends on @bloombot/config for the base URL default', () => {
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(Object.keys(packageJson.dependencies ?? {})).toContain(
      '@bloombot/config'
    )
  })
})
