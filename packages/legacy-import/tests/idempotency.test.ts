/**
 * MIG-4: importing the same snapshot twice leaves the same counts — no
 * duplicate person, no duplicated transcript — and the second run's report
 * says "matched" where the first said "created".
 */

import { afterEach, describe, expect, it } from 'vitest'

import { conversations, courses, people } from '@bloombot/db'

import { runImport } from '../src/import.js'
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

let testDb: TestPlatformDatabase
let legacyFixture: LegacyFixture
let yamlFixture: { path: string; cleanup: () => void }

afterEach(() => {
  testDb.cleanup()
  legacyFixture.cleanup()
  yamlFixture.cleanup()
})

describe('runImport idempotency (MIG-4)', () => {
  it('reports "created" the first run and "matched" the second, with no duplicates', () => {
    testDb = createTestPlatformDatabase()
    legacyFixture = createLegacyFixture()

    const legacyUserId = legacyFixture.insertUser({
      discordId: '100000000000000042',
      email: 'alice@myuni.edu',
      firstName: 'Alice',
      lastName: 'Smith',
    })
    legacyFixture.insertMessage({
      userId: legacyUserId,
      content: 'Hello!',
      category: 'Web Design - GLOBAL',
      channel: 'general',
      direction: 'from',
      createdAt: formatLegacyTimestamp(Date.parse('2026-01-15T10:00:00.000Z')),
    })
    legacyFixture.insertMessage({
      userId: legacyUserId,
      content: 'Hi Alice!',
      category: 'Web Design - GLOBAL',
      channel: 'general',
      direction: 'to',
      createdAt: formatLegacyTimestamp(Date.parse('2026-01-15T10:00:01.000Z')),
    })
    legacyFixture.close()

    yamlFixture = writeLegacyYamlFixture(twoCourseConfig('Idempotency Server'))

    const first = runImport({
      snapshotPath: legacyFixture.path,
      yamlPath: yamlFixture.path,
      db: testDb.db,
    })

    expect(first.organization.created).toBe(true)
    expect(first.project.created).toBe(true)
    expect(first.courses).toMatchObject({ created: 2, matched: 0, skipped: 0 })
    expect(first.people).toMatchObject({ created: 1, matched: 0, skipped: 0 })
    expect(first.messages).toMatchObject({
      created: 2,
      matched: 0,
      unplaceable: [],
    })

    const second = runImport({
      snapshotPath: legacyFixture.path,
      yamlPath: yamlFixture.path,
      db: testDb.db,
    })

    expect(second.organization).toEqual({
      id: first.organization.id,
      created: false,
    })
    expect(second.project).toEqual({ id: first.project.id, created: false })
    expect(second.courses).toMatchObject({ created: 0, matched: 2, skipped: 0 })
    expect(second.people).toMatchObject({ created: 0, matched: 1, skipped: 0 })
    expect(second.messages).toMatchObject({
      created: 0,
      matched: 2,
      unplaceable: [],
    })

    // No duplicates actually landed, read back through the repos.
    expect(people.listPeople(first.organization.id, testDb.db)).toHaveLength(1)
    const person = people.listPeople(first.organization.id, testDb.db)[0]!
    const conversationList = conversations.listConversationsForCourse(
      first.organization.id,
      // Both runs' courses are the same two rows, matched by title — read
      // the person's conversation for whichever one the message landed on.
      courseIdFor(first, 'Web Design'),
      testDb.db
    )
    const conversation = conversationList.find((c) => c.personId === person.id)
    expect(conversation).toBeDefined()
    const transcript = conversations.getTranscript(
      first.organization.id,
      conversation!.id,
      testDb.db
    )
    expect(transcript).toHaveLength(2)
  })
})

/**
 * `ImportReport` does not carry course ids directly, only counts and
 * conflicts — this re-derives the id for `title` by reading it back through
 * the repos, the same way `import-messages.ts` itself does.
 */
function courseIdFor(
  report: { organization: { id: string } },
  title: string
): string {
  const found = courses
    .listCourses(report.organization.id, testDb.db)
    .find((course) => course.title === title)
  if (!found) throw new Error(`course '${title}' not found`)
  return found.id
}
