/**
 * TEN-10 — `organizations.ts#deleteOrganizationData` walks a hand-written
 * list of tables, and that list has drifted from the schema three times now:
 * `roster_channel_assignments` and `content_deletions` were each patched in
 * after a real `FOREIGN KEY constraint failed` in production
 * (`organizations.ts`'s own comments on both), and this slice's own review
 * found `course_self_enrolment_intents`, `course_web_sources` and
 * `membership_invitations` missing the same way.
 *
 * Rather than add a fourth hand check, this test *derives* the expected list
 * from `schema.ts` itself: every table declared with
 * `.references(() => organizations.id)` — a real foreign key to
 * `organizations.id` — must have a `tx.delete(...)` call for it somewhere in
 * `deleteOrganizationData`. A table added to the schema later, with a foreign
 * key to `organizations.id`, and not added to that function's own cascade
 * fails *this* test instead of failing a real deletion in production a third
 * time.
 *
 * This is a structural, source-level derivation (the same "read the actual
 * source" mechanism `tests/tenant-scoping-convention.test.ts` and
 * `tests/soft-delete-convention.test.ts` already use), not a second
 * hand-written list to drift from the first.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SCHEMA_PATH = fileURLToPath(new URL('../src/schema.ts', import.meta.url))
const ORGANIZATIONS_REPO_PATH = fileURLToPath(
  new URL('../src/repos/organizations.ts', import.meta.url)
)

/**
 * Every table variable name declared in `schema.ts` that carries a real
 * foreign key to `organizations.id` — `.references(() => organizations.id)`,
 * matched against whichever `export const X = sqliteTable('table_name', ...)`
 * declaration textually precedes it. `organizations` itself is never in this
 * set (a table cannot reference itself this way in this schema), and
 * `tenant_deletions` is deliberately excluded at the schema level (its own
 * module comment: "the whole point of the row is to outlive the organization
 * it describes"), so it never matches the regex below at all — nothing here
 * needs to special-case it.
 */
function tablesReferencingOrganizations(schemaSource: string): Set<string> {
  const declarationPattern =
    /export const (\w+) = sqliteTable\(\s*['"]([a-zA-Z_]+)['"]/g
  const declarations: { index: number; varName: string }[] = []
  let declMatch: RegExpExecArray | null
  while ((declMatch = declarationPattern.exec(schemaSource))) {
    const varName = declMatch[1]
    if (varName) {
      declarations.push({ index: declMatch.index, varName })
    }
  }
  // Sorted by position so the "which table declaration is this reference
  // inside" lookup below can walk forward through them once.
  declarations.sort((a, b) => a.index - b.index)

  function tableDeclarationAt(position: number): string | undefined {
    let current: string | undefined
    for (const { index, varName } of declarations) {
      if (index <= position) {
        current = varName
      } else {
        break
      }
    }
    return current
  }

  const referencePattern = /references\(\(\) => organizations\.id\)/g
  const referencing = new Set<string>()
  let refMatch: RegExpExecArray | null
  while ((refMatch = referencePattern.exec(schemaSource))) {
    const owner = tableDeclarationAt(refMatch.index)
    if (owner) referencing.add(owner)
  }
  return referencing
}

/** Every table `deleteOrganizationData` calls `tx.delete(...)` against, by the schema variable name it deletes. */
function tablesDeletedByOrganizationCascade(repoSource: string): Set<string> {
  const start = repoSource.indexOf('export function deleteOrganizationData')
  expect(
    start,
    'deleteOrganizationData not found in organizations.ts'
  ).toBeGreaterThan(-1)
  const end = repoSource.indexOf(
    '\nexport function',
    start + 'export function deleteOrganizationData'.length
  )
  const body = repoSource.slice(start, end === -1 ? undefined : end)

  const deletePattern = /tx\.delete\((\w+)\)/g
  const deleted = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = deletePattern.exec(body))) {
    const table = match[1]
    if (table) deleted.add(table)
  }
  return deleted
}

describe('TEN-10 — the tenant cascade covers every table with a real foreign key to organizations.id', () => {
  const schemaSource = readFileSync(SCHEMA_PATH, 'utf8')
  const repoSource = readFileSync(ORGANIZATIONS_REPO_PATH, 'utf8')

  it('found more than a handful of referencing tables — a guard on the guard: an empty or tiny set would make the loop below vacuous', () => {
    const referencing = tablesReferencingOrganizations(schemaSource)
    expect(referencing.size).toBeGreaterThan(20)
  })

  it('deleteOrganizationData deletes every table the schema says references organizations.id', () => {
    const referencing = tablesReferencingOrganizations(schemaSource)
    const deleted = tablesDeletedByOrganizationCascade(repoSource)

    const missing = [...referencing].filter((table) => !deleted.has(table))
    expect(
      missing,
      `deleteOrganizationData is missing a cascade delete for: ${missing.join(', ')}`
    ).toEqual([])
  })

  // The three tables this slice's own review found missing (TEN-10's brief),
  // named explicitly so a regression in the derivation above still has a
  // human-readable failure pointing at exactly what drifted before.
  it.each([
    'courseSelfEnrolmentIntents',
    'courseWebSources',
    'membershipInvitations',
  ])(
    '%s is covered (previously missing, found during ROST-20 review)',
    (table) => {
      const deleted = tablesDeletedByOrganizationCascade(repoSource)
      expect(deleted.has(table)).toBe(true)
    }
  )
})
