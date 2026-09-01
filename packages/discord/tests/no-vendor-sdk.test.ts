/**
 * PLAT-3 (one gateway connection) / PLAT-4 (process topology): `apps/bot` is
 * the only process that may hold a Discord gateway connection, and
 * `discord.js` is the only vendor SDK that would give it one — so this
 * checks it is the only place in the workspace that imports `discord.js` (or
 * anything under the `@discordjs/` scope) at all. Read the actual source
 * rather than trust a convention nobody checks — the same shape
 * `packages/core/tests/no-vendor-sdk.test.ts` takes for CORE-4, generalized
 * here from one package's `src/` to every workspace package's.
 */

import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const VENDOR_PACKAGES = ['discord.js']
const VENDOR_SCOPE_PREFIXES = ['@discordjs/']

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Every way JavaScript can pull in a package — the same four shapes `packages/core`'s own check enumerates. */
function patternsForExactPackage(pkg: string): RegExp[] {
  const escaped = escapeRegExp(pkg)
  return [
    new RegExp(`from\\s+['"]${escaped}['"]`),
    new RegExp(`^\\s*import\\s+['"]${escaped}['"]`, 'm'),
    new RegExp(`import\\(\\s*['"]${escaped}['"]`),
    new RegExp(`require\\(\\s*['"]${escaped}['"]\\s*\\)`),
  ]
}

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

/** Every `.ts` file under `dir`, at any depth. */
function listSourceFilesRecursively(dir: string, prefix = ''): string[] {
  const entries: Dirent[] = readdirSync(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(
        ...listSourceFilesRecursively(join(dir, entry.name), relativePath)
      )
    } else if (entry.name.endsWith('.ts')) {
      files.push(relativePath)
    }
  }
  return files
}

/** Every workspace package/app that has a `src/` directory, named the way `apps/bot`/`packages/discord` are named in errors below. */
function listWorkspaceSrcDirs(): { name: string; dir: string }[] {
  const found: { name: string; dir: string }[] = []
  for (const group of ['packages', 'apps']) {
    const groupDir = join(REPO_ROOT, group)
    if (!existsSync(groupDir)) continue
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const srcDir = join(groupDir, entry.name, 'src')
      if (existsSync(srcDir)) {
        found.push({ name: `${group}/${entry.name}`, dir: srcDir })
      }
    }
  }
  return found
}

describe('discord.js is imported nowhere but apps/bot (PLAT-3, PLAT-4)', () => {
  const workspaceSrcDirs = listWorkspaceSrcDirs()

  it('found at least one workspace package with a src/ directory to check', () => {
    expect(workspaceSrcDirs.length).toBeGreaterThan(0)
  })

  // apps/bot is the one process PLAT-3 names as holding the gateway
  // connection; every other package must reach Discord through
  // @bloombot/discord's DTO and port instead.
  const otherPackages = workspaceSrcDirs.filter(
    (pkg) => pkg.name !== 'apps/bot'
  )

  for (const pkg of otherPackages) {
    const files = listSourceFilesRecursively(pkg.dir)
    for (const file of files) {
      it(`${pkg.name}/src/${file} imports no vendor Discord SDK`, () => {
        const source = readFileSync(join(pkg.dir, file), 'utf8')
        for (const pattern of forbiddenPatterns) {
          expect(
            source,
            `${pkg.name}/src/${file} matched ${pattern}`
          ).not.toMatch(pattern)
        }
      })
    }
  }

  // Finding the same shape `packages/core`'s own check ends on — the
  // constraint's real form is "no vendor SDK as a *dependency*", not merely
  // unimported today.
  for (const pkg of otherPackages) {
    it(`${pkg.name}/package.json declares no discord.js dependency`, () => {
      const packageJsonPath = join(pkg.dir, '..', 'package.json')
      if (!existsSync(packageJsonPath)) return
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
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
          `${pkg.name}/package.json declares a dependency under ${prefix}`
        ).toBe(false)
      }
    })
  }

  it('apps/bot does declare discord.js as a dependency — the one place it belongs', () => {
    const packageJsonPath = join(REPO_ROOT, 'apps', 'bot', 'package.json')
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(Object.keys(packageJson.dependencies ?? {})).toContain('discord.js')
  })

  it('apps/bot does import discord.js somewhere — the check above would pass vacuously otherwise', () => {
    const botSrcDir = join(REPO_ROOT, 'apps', 'bot', 'src')
    const files = listSourceFilesRecursively(botSrcDir)
    const importsDiscordJs = files.some((file) => {
      const source = readFileSync(join(botSrcDir, file), 'utf8')
      return forbiddenPatterns.some((pattern) => pattern.test(source))
    })
    expect(importsDiscordJs).toBe(true)
  })
})
