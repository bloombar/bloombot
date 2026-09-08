/**
 * CORE-4: the core depends on `ModelClient` (`src/ports.ts`) alone, never on
 * a vendor SDK. Read the actual source rather than trust a convention nobody
 * checks — the same shape `packages/legacy-import/tests/no-raw-sql.test.ts`
 * takes for "writes only through the repos".
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url))
const PACKAGE_JSON_PATH = fileURLToPath(
  new URL('../package.json', import.meta.url)
)

// Vendor package names (or scope prefixes) a Discord or OpenAI SDK would
// appear under — the two vendors named in the brief as "the next two
// slices". `escapeRegExp` guards `discord.js`'s `.`, which would otherwise
// match any character in a regex.
const VENDOR_PACKAGES = ['openai', 'discord.js']
const VENDOR_SCOPE_PREFIXES = ['@discordjs/']

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Every way JavaScript can pull in a package — `from '<pkg>'`, a bare
 * side-effect `import '<pkg>'` (finding 11 of the CORE-1 rework: the
 * original list only matched `from`), a dynamic `import('<pkg>')`, and
 * `require('<pkg>')` — for one exact package name.
 */
function patternsForExactPackage(pkg: string): RegExp[] {
  const escaped = escapeRegExp(pkg)
  return [
    new RegExp(`from\\s+['"]${escaped}['"]`),
    new RegExp(`^\\s*import\\s+['"]${escaped}['"]`, 'm'),
    new RegExp(`import\\(\\s*['"]${escaped}['"]`),
    new RegExp(`require\\(\\s*['"]${escaped}['"]\\s*\\)`),
  ]
}

/** The same four import shapes, for any subpath under a scope (`@discordjs/builders`, `@discordjs/rest`, …). */
function patternsForScopePrefix(prefix: string): RegExp[] {
  const escaped = escapeRegExp(prefix)
  return [
    new RegExp(`from\\s+['"]${escaped}`),
    new RegExp(`^\\s*import\\s+['"]${escaped}`, 'm'),
    new RegExp(`import\\(\\s*['"]${escaped}`),
    new RegExp(`require\\(\\s*['"]${escaped}`),
  ]
}

const forbiddenPatterns = [
  ...VENDOR_PACKAGES.flatMap(patternsForExactPackage),
  ...VENDOR_SCOPE_PREFIXES.flatMap(patternsForScopePrefix),
]

/**
 * Every `.ts` file under `SRC_DIR`, at any depth — finding 11: the original
 * `readdirSync` was not recursive, so a future `src/adapters/openai.ts`
 * would never be scanned. `withFileTypes` is what lets this tell a
 * directory from a file without a second `statSync` per entry.
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

describe('packages/core imports no vendor SDK (CORE-4)', () => {
  const files = listSourceFilesRecursively(SRC_DIR)

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

  // Finding 11 — the constraint's actual form: no vendor SDK as a
  // *dependency* of this package at all, not merely unimported today.
  it('package.json declares no vendor SDK dependency', () => {
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const declaredPackages = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
      ...Object.keys(packageJson.peerDependencies ?? {}),
    ]

    for (const vendorPackage of VENDOR_PACKAGES) {
      expect(declaredPackages).not.toContain(vendorPackage)
    }
    for (const prefix of VENDOR_SCOPE_PREFIXES) {
      expect(
        declaredPackages.some((name) => name.startsWith(prefix)),
        `package.json declares a dependency under ${prefix}`
      ).toBe(false)
    }
  })
})

/**
 * CORE-7 — the defect this guard would have caught: `answer.ts` used to
 * build Discord's own mention token (an angle bracket, an `@`, then an id)
 * as a plain string literal, not an import, so every check above — which
 * only looks for a vendor SDK being *pulled in* — never saw it. A vendor's
 * own wire syntax embedded as a literal is the same "this package now knows
 * about one surface" violation CORE-4 already forbids for an SDK import;
 * this scans for the literal two-character token no legitimate line of
 * `packages/core/src` should ever contain, surface syntax or otherwise.
 *
 * A known, accepted limitation, worth stating rather than leaving implied
 * (found in review): this only catches the *literal* token — writing the
 * same mention by concatenation (`'<' + '@' + id + '>'`) or any other
 * obfuscation passes cleanly. This is the weaker of two layers, not the
 * only one: `packages/core/tests/answer.test.ts`'s own CORE-7/CORE-8 block
 * asserts on actual behaviour (an `EchoingModelClient` proving the reply
 * text itself, not merely a request field), which no string-shaped dodge of
 * this guard can pass. This guard exists for the cheap, fast case — a
 * future contributor pasting the obvious literal back in — not as the
 * platform's only defence against the defect class.
 */
describe('packages/core contains no surface-specific address syntax (CORE-7)', () => {
  const files = listSourceFilesRecursively(SRC_DIR)

  for (const file of files) {
    it(`${file} contains no Discord-style mention token`, () => {
      const source = readFileSync(`${SRC_DIR}/${file}`, 'utf8')
      expect(source, `${file} contains a literal "<@"`).not.toContain('<@')
    })
  }
})
