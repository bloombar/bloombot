/**
 * `transcripts.read`/`.listStudents`/`.export`/`.listExports` (ADMIN-1..3) —
 * against a real, throwaway database (never `data/`, QA-2, QA-3).
 */

import { conversations, jobs, people, type Database } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import {
  exportTranscriptAction,
  listTranscriptExportsAction,
  listTranscriptStudentsAction,
  readTranscriptAction,
} from '../src/actions/transcripts.js'
import { dispatch } from '../src/dispatch.js'
import { ActionRefusedError } from '../src/errors.js'
import { seedOrganizationWithCourse } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** A student who has never proven a verified address — a Discord-only person, the common case (this file's own scenario for PPL-5). */
function seedDiscordOnlyStudent(organizationId: string, db: Database) {
  return people.resolvePersonByIdentity(
    organizationId,
    { surface: 'discord', externalId: `snowflake-${crypto.randomUUID()}` },
    db
  )
}

/** A student with a verified address — a `web` identity, the only proxy this platform has for one (PPL-5, `people.ts#hasVerifiedAddress`'s own doc comment). */
function seedVerifiedStudent(organizationId: string, db: Database) {
  return people.resolvePersonByIdentity(
    organizationId,
    { surface: 'web', externalId: `account-${crypto.randomUUID()}` },
    db
  )
}

function seedMessage(
  organizationId: string,
  courseId: string,
  personId: string,
  content: string,
  db: Database
) {
  const conversation = conversations.getOrCreateConversation(
    organizationId,
    { courseId, personId, surface: 'web' },
    db
  )
  if (!conversation) throw new Error('setup failed: conversation')
  conversations.appendMessage(
    organizationId,
    conversation.id,
    { direction: 'from_person', content },
    db
  )
}

describe('transcripts.read (ADMIN-1)', () => {
  it('reads a course transcript', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const student = seedDiscordOnlyStudent(organizationId, testDb.db)
    seedMessage(organizationId, course.id, student.id, 'Hi!', testDb.db)

    const result = await dispatch(
      readTranscriptAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.content).toBe('Hi!')
  })

  // ADMIN-2 — from the action's own side: a caller with no account id
  // cannot read a transcript at all, so an access nobody is attributed for
  // is never possible through this action.
  it('refuses when dispatch was given no accountId', async () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb.db)

    await expect(
      dispatch(
        readTranscriptAction,
        { courseId: course.id },
        { organizationId, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it('refuses a course belonging to another organization (TEN-5)', async () => {
    testDb = createTestDatabase()
    const { ownerId, course } = seedOrganizationWithCourse(testDb.db)
    const { organizationId: otherOrg } = seedOrganizationWithCourse(testDb.db)

    await expect(
      dispatch(
        readTranscriptAction,
        { courseId: course.id },
        { organizationId: otherOrg, db: testDb.db, accountId: ownerId }
      )
    ).rejects.toThrow(ActionRefusedError)
  })
})

describe('transcripts.listStudents (ADMIN-1)', () => {
  it('lists every student the transcript covers', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const student = seedDiscordOnlyStudent(organizationId, testDb.db)
    seedMessage(organizationId, course.id, student.id, 'Hi!', testDb.db)

    const result = await dispatch(
      listTranscriptStudentsAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    expect(result).toEqual([{ personId: student.id, personDisplayName: null }])
  })
})

describe('transcripts.export (ADMIN-3)', () => {
  it('enqueues a job and records a pending export for a whole-course export', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )

    const result = await dispatch(
      exportTranscriptAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    expect(result.exportId).toBeTruthy()
    const job = jobs.getJob(organizationId, result.jobId, testDb.db)
    expect(job?.kind).toBe('transcripts.export')
    expect(job?.status).toBe('pending')
  })

  it('refuses when dispatch was given no accountId', async () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb.db)

    await expect(
      dispatch(
        exportTranscriptAction,
        { courseId: course.id },
        { organizationId, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  // PPL-5 — this file's own module comment on `transcripts.ts`: a
  // student-filtered export is refused unless that student's own address
  // has been verified. The common, Discord-only case.
  it('refuses a student-filtered export for a student with no verified address (PPL-5)', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const student = seedDiscordOnlyStudent(organizationId, testDb.db)

    await expect(
      dispatch(
        exportTranscriptAction,
        { courseId: course.id, personId: student.id },
        { organizationId, db: testDb.db, accountId: ownerId }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it('allows a student-filtered export once that student has a verified address (PPL-5)', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const student = seedVerifiedStudent(organizationId, testDb.db)

    const result = await dispatch(
      exportTranscriptAction,
      { courseId: course.id, personId: student.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    expect(result.exportId).toBeTruthy()
  })

  it('does not gate a whole-course export on any single student’s verified address', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    // A Discord-only student exists in the course, but the export names no
    // single student — PPL-5's gate does not apply (this action's own
    // module comment).
    seedDiscordOnlyStudent(organizationId, testDb.db)

    const result = await dispatch(
      exportTranscriptAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    expect(result.exportId).toBeTruthy()
  })
})

describe('transcripts.listExports (ADMIN-3)', () => {
  it('lists a course’s exports, most recent first', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )

    const first = await dispatch(
      exportTranscriptAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    const second = await dispatch(
      exportTranscriptAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    const result = await dispatch(
      listTranscriptExportsAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    expect(result.map((entry) => entry.id)).toEqual([
      second.exportId,
      first.exportId,
    ])
    expect(result.every((entry) => entry.status === 'pending')).toBe(true)
  })
})
