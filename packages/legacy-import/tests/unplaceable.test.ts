/**
 * MIG-4: a message in a category no course declares appears in the report
 * and is not written, and the CLI's exit-code decision (`reportHasUnplaced`)
 * says so.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { conversations, courses, people } from '@bloombot/db'

import { reportHasUnplaced, runImport } from '../src/import.js'
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

describe('runImport — unplaceable messages (MIG-4)', () => {
  it('reports a message whose category matches no course, does not write it, and flags the run as unplaced', () => {
    testDb = createTestPlatformDatabase()
    legacyFixture = createLegacyFixture()

    const legacyUserId = legacyFixture.insertUser({
      discordId: '100000000000000099',
    })
    legacyFixture.insertMessage({
      userId: legacyUserId,
      content: 'Where is the syllabus for a course that does not exist?',
      category: 'Some Unrelated Category',
      channel: 'general',
      direction: 'from',
      createdAt: formatLegacyTimestamp(Date.now()),
    })
    legacyFixture.close()

    yamlFixture = writeLegacyYamlFixture(twoCourseConfig('Unplaceable Server'))

    const report = runImport({
      snapshotPath: legacyFixture.path,
      yamlPath: yamlFixture.path,
      db: testDb.db,
    })

    expect(report.messages.created).toBe(0)
    expect(report.messages.unplaceable).toHaveLength(1)
    expect(report.messages.unplaceable[0]?.reason).toMatch(
      /Some Unrelated Category/
    )
    expect(reportHasUnplaced(report)).toBe(true)

    // The person still imports (their identity is unrelated to the message's
    // category) — only the message itself is unplaced.
    expect(people.listPeople(report.organization.id, testDb.db)).toHaveLength(1)
    // No conversation was opened for it on either imported course — the
    // unplaced message never reached `getOrCreateConversation` at all.
    for (const course of courses.listCourses(
      report.organization.id,
      testDb.db
    )) {
      expect(
        conversations.listConversationsForCourse(
          report.organization.id,
          course.id,
          testDb.db
        )
      ).toHaveLength(0)
    }
  })

  it('a fully-placed run reports no unplaced rows', () => {
    testDb = createTestPlatformDatabase()
    legacyFixture = createLegacyFixture()
    legacyFixture.close()
    yamlFixture = writeLegacyYamlFixture(twoCourseConfig('Clean Server'))

    const report = runImport({
      snapshotPath: legacyFixture.path,
      yamlPath: yamlFixture.path,
      db: testDb.db,
    })

    expect(reportHasUnplaced(report)).toBe(false)
  })
})
