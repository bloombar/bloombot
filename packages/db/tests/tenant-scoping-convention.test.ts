/**
 * TEN-2 is a convention ("the first parameter is the organization id"), and a
 * convention nobody checks is one the twentieth repo function quietly breaks.
 * This test reads the actual source of `src/repos/**` and enforces it
 * structurally, rather than trusting every future PR to remember the rule —
 * with an explicit allowlist for the two functions the brief documents as
 * legitimately unscoped.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const REPOS_DIR = fileURLToPath(new URL('../src/repos', import.meta.url))

// TEN-2's two documented exceptions, and why each is safe:
//  - accounts.ts#getAccountByEmail: an account exists before any organization
//    does, so sign-in has to find it by email alone.
//  - discord-servers.ts#resolveDiscordServerBinding: this *is* the lookup
//    that establishes which organization an incoming Discord message
//    belongs to, so it cannot itself take an organization id as input.
const ALLOWLIST: Record<string, string[]> = {
  'accounts.ts': ['getAccountByEmail'],
  'discord-servers.ts': ['resolveDiscordServerBinding'],
}

interface ExportedFunction {
  name: string
  firstParamName: string | undefined
}

/** Every top-level `export function` declaration in a TS source file. */
function exportedFunctions(source: string): ExportedFunction[] {
  const found: ExportedFunction[] = []
  // `[^)]*` deliberately spans newlines (it excludes only `)`, not `\n`), so
  // this matches a parameter list formatted across multiple lines just as
  // well as one written on a single line.
  const pattern = /export function (\w+)\(([^)]*)\)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    // Both groups always capture when the pattern matches at all — the
    // `?? ''` fallbacks are here only to satisfy `noUncheckedIndexedAccess`.
    const name = match[1] ?? ''
    const params = (match[2] ?? '').trim()
    const firstParamName =
      params.length === 0
        ? undefined
        : (params.split(',')[0] ?? '')
            .trim()
            .split(':')[0]
            ?.trim()
            .replace(/\?$/, '')
    found.push({ name, firstParamName })
  }
  return found
}

describe('TEN-2 — repo functions are scoped by organization id, structurally', () => {
  const files = readdirSync(REPOS_DIR).filter((name) => name.endsWith('.ts'))

  it('found the four repo files this test is written against', () => {
    // A guard on the guard: if a new repo file appears and this list is not
    // updated, the loop below silently would not check it either.
    expect(files.sort()).toEqual(
      [
        'accounts.ts',
        'discord-servers.ts',
        'memberships.ts',
        'organizations.ts',
      ].sort()
    )
  })

  for (const file of files) {
    it(`${file}: every exported function's first parameter is organizationId, except the allowlisted exceptions`, () => {
      const source = readFileSync(`${REPOS_DIR}/${file}`, 'utf8')
      const fns = exportedFunctions(source)

      // A file with no exported functions at all would make this test
      // vacuously true and hide a broken import path — assert it actually
      // found something to check.
      expect(fns.length).toBeGreaterThan(0)

      const allowedInThisFile = ALLOWLIST[file] ?? []
      for (const fn of fns) {
        if (allowedInThisFile.includes(fn.name)) continue
        expect(fn.firstParamName, `${file}#${fn.name}`).toBe('organizationId')
      }
    })
  }

  it('the allowlist names only functions that actually exist', () => {
    for (const [file, names] of Object.entries(ALLOWLIST)) {
      const source = readFileSync(`${REPOS_DIR}/${file}`, 'utf8')
      const exported = exportedFunctions(source).map((fn) => fn.name)
      for (const name of names) {
        expect(exported).toContain(name)
      }
    }
  })
})
