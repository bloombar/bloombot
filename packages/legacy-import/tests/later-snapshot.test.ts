/**
 * MIG-5: importing a later legacy snapshot whose row ids restart at 1.
 *
 * Fixture "A" is the snapshot already imported (rows 1..6). Fixture "B" is a
 * later snapshot of the same server from a different database lineage: its
 * rows 1..3 are messages A already holds (under different ids, and with
 * ids that collide with *different* A messages), and rows 4..6 are new — row
 * 4 collides with A's row 4, rows 5..6 come from a person A never saw.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { conversations, courses, people } from '@bloombot/db'

import { parseCliArgs } from '../src/cli-args.js'
import { runImport, type ImportReport } from '../src/import.js'
import { twoCourseConfig } from './helpers/config-fixture.js'
import {
  createLegacyFixture,
  formatLegacyTimestamp,
  type LegacyFixture,
} from './helpers/legacy-fixture.js'
import {
  createTestPlatformDatabase,
  type TestPlatformDatabase,
} from './helpers/platform-db.js'
import { writeLegacyYamlFixture } from './helpers/yaml-fixture.js'

const CATEGORY = 'Web Design - GLOBAL'
const ALICE = '100000000000000001'
const BOB = '100000000000000002'
const CAROL = '100000000000000003'

const T0 = Date.parse('2026-01-15T10:00:00.000Z')
const at = (seconds: number, extraMs = 0): string =>
  formatLegacyTimestamp(T0 + seconds * 1000 + extraMs)

let testDb: TestPlatformDatabase
let fixtures: LegacyFixture[]
let yamlFixture: { path: string; cleanup: () => void }

afterEach(() => {
  testDb.cleanup()
  for (const fixture of fixtures) fixture.cleanup()
  yamlFixture.cleanup()
})

function message(
  userId: number,
  content: string,
  seconds: number,
  extraMs = 0,
  direction: 'to' | 'from' = 'from'
) {
  return {
    userId,
    content,
    category: CATEGORY,
    channel: 'general',
    direction,
    createdAt: at(seconds, extraMs),
  }
}

/** Legacy A: alice and bob, six messages with ids 1..6. */
function buildA(): LegacyFixture {
  const a = createLegacyFixture()
  const alice = a.insertUser({ discordId: ALICE, firstName: 'Alice' })
  const bob = a.insertUser({ discordId: BOB, firstName: 'Bob' })
  a.insertMessage(message(alice, 'a-1 hello', 0))
  a.insertMessage(message(alice, 'a-2 reply', 1, 0, 'to'))
  a.insertMessage(message(bob, 'a-3 bob hi', 2))
  a.insertMessage(message(bob, 'a-4 bob more', 3))
  a.insertMessage(message(alice, 'a-5 later', 4))
  a.insertMessage(message(bob, 'a-6 last', 5))
  a.close()
  return a
}

/** Legacy B: user and message ids restart at 1 and do not line up with A's. */
function buildB(): LegacyFixture {
  const b = createLegacyFixture()
  const bob = b.insertUser({ discordId: BOB, firstName: 'Bob' })
  const alice = b.insertUser({ discordId: ALICE, firstName: 'Alice' })
  const carol = b.insertUser({ discordId: CAROL, firstName: 'Carol' })
  // 1..3 repeat A's messages: a sub-second difference, and padded content.
  b.insertMessage(message(bob, 'a-3 bob hi', 2))
  b.insertMessage(message(alice, 'a-1 hello  ', 0, 400))
  b.insertMessage(message(alice, 'a-2 reply', 1, 0, 'to'))
  // 4..6 are new. Row 4 shares its id with A's 'a-4 bob more'.
  b.insertMessage(message(alice, 'b-4 alice new', 10))
  b.insertMessage(message(carol, 'b-5 carol first', 11))
  b.insertMessage(message(carol, 'b-6 carol second', 12))
  b.close()
  return b
}

function setup(): { a: LegacyFixture; b: LegacyFixture } {
  testDb = createTestPlatformDatabase()
  const a = buildA()
  const b = buildB()
  fixtures = [a, b]
  yamlFixture = writeLegacyYamlFixture(twoCourseConfig('Later Snapshot Server'))
  return { a, b }
}

function run(path: string, source?: string): ImportReport {
  return runImport({
    snapshotPath: path,
    yamlPath: yamlFixture.path,
    db: testDb.db,
    ...(source === undefined ? {} : { source }),
  })
}

/** Every message in the Web Design course, as `content`, in no promised order. */
function allContents(report: ImportReport): string[] {
  const course = courses
    .listCourses(report.organization.id, testDb.db)
    .find((c) => c.title === 'Web Design')!
  return conversations
    .listConversationsForCourse(report.organization.id, course.id, testDb.db)
    .flatMap((c) =>
      conversations.getTranscript(report.organization.id, c.id, testDb.db)
    )
    .map((m) => m.content.trim())
    .sort()
}

describe('importing a later snapshot with --source (MIG-5)', () => {
  it('creates exactly the new messages: none duplicated, none lost', () => {
    const { a, b } = setup()
    run(a.path)
    const report = run(b.path, 'b')

    expect(report.messages).toMatchObject({
      created: 3,
      matched: 0,
      matchedByContent: 3,
      unplaceable: [],
    })
    expect(allContents(report)).toEqual(
      [
        'a-1 hello',
        'a-2 reply',
        'a-3 bob hi',
        'a-4 bob more',
        'a-5 later',
        'a-6 last',
        'b-4 alice new',
        'b-5 carol first',
        'b-6 carol second',
      ].sort()
    )
  })

  it('reuses existing people, course and conversation; a new person gets one person and one identity', () => {
    const { a, b } = setup()
    const first = run(a.path)
    const orgId = first.organization.id
    const courseCount = courses.listCourses(orgId, testDb.db).length
    const report = run(b.path, 'b')

    expect(report.courses).toMatchObject({ created: 0, matched: 2 })
    expect(report.people).toMatchObject({ created: 1, matched: 2, skipped: 0 })
    expect(courses.listCourses(orgId, testDb.db)).toHaveLength(courseCount)

    const everyone = people.listPeople(orgId, testDb.db)
    expect(everyone).toHaveLength(3)
    for (const externalId of [ALICE, BOB, CAROL]) {
      const owners = everyone.filter(
        (p) =>
          people.resolveIdentity(
            orgId,
            { surface: 'discord', externalId },
            testDb.db
          )?.id === p.id
      )
      expect(owners).toHaveLength(1)
    }

    // One conversation per (course, person): alice's was reused, and the new
    // messages come after the old ones in sequence.
    const course = courses
      .listCourses(orgId, testDb.db)
      .find((c) => c.title === 'Web Design')!
    const convos = conversations.listConversationsForCourse(
      orgId,
      course.id,
      testDb.db
    )
    expect(convos).toHaveLength(3)
    const alice = people.resolveIdentity(
      orgId,
      { surface: 'discord', externalId: ALICE },
      testDb.db
    )!
    const aliceConvo = convos.find((c) => c.personId === alice.id)!
    const transcript = conversations.getTranscript(
      orgId,
      aliceConvo.id,
      testDb.db
    )
    expect(transcript.map((m) => m.content.trim())).toEqual([
      'a-1 hello',
      'a-2 reply',
      'a-5 later',
      'b-4 alice new',
    ])
    expect(transcript.map((m) => m.sequence)).toEqual([0, 1, 2, 3])
  })

  it('changes nothing when B is re-run with the same source', () => {
    const { a, b } = setup()
    run(a.path)
    const first = run(b.path, 'b')
    const before = allContents(first)
    const second = run(b.path, 'b')

    expect(second.messages).toMatchObject({
      created: 0,
      matched: 3,
      matchedByContent: 3,
    })
    expect(second.people).toMatchObject({ created: 0 })
    expect(allContents(second)).toEqual(before)
  })

  it('changes nothing when A is re-run without a source (backward compatible)', () => {
    const { a, b } = setup()
    run(a.path)
    run(b.path, 'b')
    const again = run(a.path)

    expect(again.messages).toMatchObject({
      created: 0,
      matched: 6,
      matchedByContent: 0,
      unplaceable: [],
    })
    expect(allContents(again)).toHaveLength(9)
  })

  it('without --source, a later snapshot loses its new rows to id collisions (why the flag exists)', () => {
    const { a, b } = setup()
    run(a.path)
    const report = run(b.path)
    // Row 4 collides with A's row 4 and is wrongly "matched by id".
    expect(report.messages.matched).toBeGreaterThan(0)
    expect(allContents(report)).not.toContain('b-4 alice new')
  })

  it('leaves every foreign key satisfied', () => {
    const { a, b } = setup()
    run(a.path)
    run(b.path, 'b')
    expect(testDb.db.$client.pragma('foreign_key_check')).toEqual([])
  })
})

describe('parseCliArgs --source (MIG-5)', () => {
  it('reads the label in both spellings, alongside the paths and --i-know', () => {
    expect(parseCliArgs(['s.db', 'c.yml', '--source', 'b'])).toEqual({
      snapshotPath: 's.db',
      yamlPath: 'c.yml',
      source: 'b',
    })
    expect(
      parseCliArgs(['--source=b', 's.db', 'c.yml', '--i-know']).source
    ).toBe('b')
    expect(parseCliArgs(['s.db', 'c.yml']).source).toBeUndefined()
  })

  it('refuses an empty or missing value', () => {
    expect(() => parseCliArgs(['s.db', 'c.yml', '--source'])).toThrow(
      /non-empty/
    )
    expect(() => parseCliArgs(['s.db', 'c.yml', '--source', ''])).toThrow(
      /non-empty/
    )
    expect(() => parseCliArgs(['s.db', 'c.yml', '--source='])).toThrow(
      /non-empty/
    )
    expect(() => parseCliArgs(['--source', '--i-know', 's.db'])).toThrow(
      /non-empty/
    )
  })
})
