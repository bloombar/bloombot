/**
 * DATA-9 is a convention ("every read of a deletable entity excludes what is
 * marked deleted") the exact same way TEN-2's organization scoping is — a
 * convention nobody checks is one the twentieth query quietly breaks. This
 * test is the analogue `tests/tenant-scoping-convention.test.ts` already is
 * for TEN-2: it reads the actual source of `src/repos/**`, finds every
 * exported function that reads one of the six deletable tables (DATA-7:
 * `accounts`, `people`, `organizations`, `projects`, `courses`,
 * `conversations`), and fails one whose body never mentions that table's own
 * `deletedAt` column — with a named allowlist for the deliberate exceptions.
 *
 * Like its TEN-2 sibling, this is a heuristic, not a proof: it cannot tell
 * "mentions `deletedAt`" from "actually filters by it correctly" (a
 * `restoreX` function legitimately mentions `deletedAt` while un-marking a
 * row, not while hiding one). What it does catch — and was built, then
 * proven, against a deliberately unfiltered query added and then removed for
 * exactly this purpose (see this slice's own report) — is the far more
 * common mistake: a query against a deletable table that never considers
 * `deletedAt` at all.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const REPOS_DIR = fileURLToPath(new URL('../src/repos', import.meta.url))

/** DATA-7's own six deletable entity kinds, by their table name in `schema.ts`. */
const DELETABLE_TABLES = [
  'accounts',
  'people',
  'organizations',
  'projects',
  'courses',
  'conversations',
] as const

// DATA-9's own three named exceptions, plus the shape this platform already
// carves out for a *permanent*, irreversible removal (ADMIN-5/PROJ-8/PROJ-9),
// which — unlike every ordinary read — must see every row regardless of
// whether it is already soft-deleted, because deleting a tenant or a course
// outright has to remove what was soft-deleted too, not leave it behind.
//
//  - organizations.ts#previewOrganizationDeletion / deletions.ts#previewCourseDeletion /
//    deletions.ts#previewProjectDeletion / deletions.ts#deleteCourse /
//    deletions.ts#deleteProject: ADMIN-5/PROJ-8/PROJ-9's own hard, permanent
//    wipe — counts and removes every row a tenant/course/project owns,
//    including one already marked deleted, since a soft-deleted course must
//    still be physically gone once its whole organization is wiped. This
//    slice does not change that operation; DATA-8's later sweep is what
//    eventually reuses something like it for what soft-delete leaves behind.
//  - organizations.ts#restoreOrganization / projects.ts#restoreProject /
//    courses.ts#restoreCourse / conversations.ts#restoreConversationsForPerson:
//    DATA-9's own "a restore" exception — a restore has to find the exact
//    tombstoned row it is meant to un-mark, which every other read in this
//    package exists to hide.
//  - people.ts#mergePeople: LINK-4's own combination of two people's rows —
//    it moves a loser's conversations onto the survivor (or combines the
//    two transcripts, that function's own doc comment) regardless of
//    whether either carries a `deletedAt`, the same way it already moves
//    every other column untouched; a soft-deleted conversation's own
//    tombstone is preserved through the move, not read or cleared by it,
//    so this is a data-combination operation on raw rows, not a "read" that
//    answers a caller's question the way every other function in this file
//    is.
//  - cost-ledger.ts#getAccountUsageSummary / roster-import-acknowledgements.ts#listAcknowledgementsForAccount:
//    an account's own historical record — what it spent, what it
//    acknowledged — survives the course it names being soft-deleted later,
//    the same way `cost_ledger_entries.courseId` already survives a course's
//    *permanent* deletion (PROJ-8's own null-not-delete carve-out,
//    `schema.ts`). Hiding an account's own history because the course it
//    happened in was later deleted would make the account's own record of
//    its own past incomplete for a reason that has nothing to do with the
//    account.
const ALLOWLIST: Record<string, string[]> = {
  'organizations.ts': ['previewOrganizationDeletion', 'restoreOrganization'],
  'deletions.ts': [
    'previewCourseDeletion',
    'previewProjectDeletion',
    'deleteCourse',
    'deleteProject',
  ],
  'projects.ts': ['restoreProject'],
  'courses.ts': ['restoreCourse'],
  'conversations.ts': ['restoreConversationsForPerson'],
  'people.ts': ['mergePeople'],
  'cost-ledger.ts': ['getAccountUsageSummary'],
  'roster-import-acknowledgements.ts': ['listAcknowledgementsForAccount'],
}

interface ExportedFunction {
  name: string
  index: number
  bodyStart: number
}

/**
 * Every top-level exported function in a TS source file, in both the
 * `export function foo(...)` and `export const foo = (...) => ...` shapes —
 * the same two shapes `tests/tenant-scoping-convention.test.ts`'s own
 * `exportedFunctions` already recognises, duplicated here rather than
 * imported: that file's version is module-private, and a shared helper
 * across two convention tests is more coupling than either buys back.
 */
function exportedFunctions(source: string): ExportedFunction[] {
  const found: ExportedFunction[] = []
  const patterns = [
    /export (?:async )?function (\w+)\(/g,
    /export const (\w+) = (?:async )?\(/g,
  ]
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source))) {
      const name = match[1] ?? ''
      found.push({
        name,
        index: match.index,
        bodyStart: match.index + match[0].length,
      })
    }
  }
  return found.sort((a, b) => a.index - b.index)
}

/**
 * Every alias a table is imported under in this file's own `from
 * '../schema.js'` import — usually just the table's own name, but a file
 * that also imports a same-named repo module (`enrolments.ts` imports both
 * `repos/courses.ts` as `courses` and `schema.ts`'s own `courses` table,
 * so the table is imported `courses as coursesTable`) aliases it instead.
 * Always includes the bare table name itself, so a file with no aliasing at
 * all is still found.
 */
function tableAliases(source: string, table: string): string[] {
  const aliases = new Set<string>([table])
  const aliasPattern = new RegExp(`\\b${table}\\s+as\\s+(\\w+)`, 'g')
  let match: RegExpExecArray | null
  while ((match = aliasPattern.exec(source))) {
    const alias = match[1]
    if (alias) aliases.add(alias)
  }
  return [...aliases]
}

describe('DATA-9 — repo reads of a deletable table exclude what is marked deleted', () => {
  const files = readdirSync(REPOS_DIR).filter((name) => name.endsWith('.ts'))

  it('found at least one repo file to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    it(`${file}: every exported function reading a deletable table also mentions that table's own deletedAt, except the allowlisted exceptions`, () => {
      const source = readFileSync(`${REPOS_DIR}/${file}`, 'utf8')
      const fns = exportedFunctions(source)
      const allowedInThisFile = ALLOWLIST[file] ?? []

      for (const [i, fn] of fns.entries()) {
        if (allowedInThisFile.includes(fn.name)) continue
        const nextStart = fns[i + 1]?.index ?? source.length
        const body = source.slice(fn.bodyStart, nextStart)

        for (const table of DELETABLE_TABLES) {
          const aliases = tableAliases(source, table)
          const readsTable = aliases.some(
            (alias) =>
              body.includes(`.from(${alias})`) ||
              body.includes(`Join(${alias},`)
          )
          if (!readsTable) continue

          const mentionsDeletedAt = aliases.some((alias) =>
            body.includes(`${alias}.deletedAt`)
          )
          expect(
            mentionsDeletedAt,
            `${file}#${fn.name} reads "${table}" but never mentions ${table}.deletedAt`
          ).toBe(true)
        }
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
