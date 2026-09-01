/**
 * TEN-4: "every request takes its base URL from configuration" — a
 * hardcoded `discord.com` anywhere in this package is exactly the defect
 * `packages/openai/tests/no-vendor-hostname.test.ts` (MDL-7) exists to
 * catch there; this is that same check, extended to cover this package too
 * — read the actual source rather than trust a convention nobody checks.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url))
const PACKAGE_JSON_PATH = fileURLToPath(
  new URL('../package.json', import.meta.url)
)

const FORBIDDEN_HOSTNAME_PATTERNS = [/discord\.com/]

/** Every `.ts` file under `SRC_DIR`, at any depth — the same recursive walk `packages/openai`'s own check uses. */
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

describe('packages/discord-rest hardcodes no Discord hostname (TEN-4)', () => {
  const files = listSourceFilesRecursively(SRC_DIR)

  it('found at least one source file to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`${file} contains no literal Discord hostname`, () => {
      const source = readFileSync(`${SRC_DIR}/${file}`, 'utf8')
      for (const pattern of FORBIDDEN_HOSTNAME_PATTERNS) {
        expect(source, `${file} matched ${pattern}`).not.toMatch(pattern)
      }
    })
  }

  it('client.ts reads its base URLs from CONFIG.DISCORD_API_BASE / CONFIG.DISCORD_OAUTH_BASE rather than defaulting them itself', () => {
    const source = readFileSync(`${SRC_DIR}/client.ts`, 'utf8')
    expect(source).toMatch(/CONFIG\.DISCORD_API_BASE/)
    expect(source).toMatch(/CONFIG\.DISCORD_OAUTH_BASE/)
  })

  it('authorize-url.ts reads its base URL from CONFIG.DISCORD_OAUTH_BASE rather than defaulting it itself', () => {
    const source = readFileSync(`${SRC_DIR}/authorize-url.ts`, 'utf8')
    expect(source).toMatch(/CONFIG\.DISCORD_OAUTH_BASE/)
  })

  // The base URLs' real defaults (`https://discord.com/api/v10`,
  // `https://discord.com/api/oauth2`) live in exactly one place,
  // `@bloombot/config`'s `env.ts` (QA-2) — this package depends on it for
  // those defaults rather than declaring its own.
  it('package.json depends on @bloombot/config for the base URL defaults', () => {
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(Object.keys(packageJson.dependencies ?? {})).toContain(
      '@bloombot/config'
    )
  })
})
