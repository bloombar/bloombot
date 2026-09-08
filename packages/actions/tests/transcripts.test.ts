/**
 * `transcripts.read`/`.listStudents`/`.export`/`.listExports`/`.listAccessLog`
 * (ADMIN-1..3) — against a real, throwaway database (never `data/`, QA-2,
 * QA-3).
 */

import { randomUUID } from 'node:crypto'

import {
  accounts,
  conversations,
  jobs,
  people,
  type Database,
} from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import {
  exportTranscriptAction,
  listTranscriptAccessLogAction,
  listTranscriptExportsAction,
  listTranscriptStudentsAction,
  readTranscriptAction,
} from '../src/actions/transcripts.js'
import { dispatch } from '../src/dispatch.js'
import { ActionConflictError, ActionRefusedError } from '../src/errors.js'
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
  // has been verified. The common, Discord-only case. Must-fix 4 of the
  // ADMIN-1..5 rework: `ActionConflictError`, not the generic
  // `ActionRefusedError` — this instructor already sees this student by
  // name (the same filter dropdown ADMIN-1's own read uses), so naming the
  // real reason discloses nothing new to them (D-18's own reasoning for
  // `ActionConflictError` at all).
  it('refuses a student-filtered export for a student with no verified address, naming why (PPL-5)', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const student = seedDiscordOnlyStudent(organizationId, testDb.db)

    const attempt = dispatch(
      exportTranscriptAction,
      { courseId: course.id, personId: student.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    await expect(attempt).rejects.toThrow(ActionConflictError)
    await expect(attempt).rejects.toMatchObject({
      conflict: { message: expect.stringContaining('verified an address') },
    })
  })

  // TEN-5 — unlike the case above, a `personId` that does not resolve at
  // all (a foreign organization's person, or one that never existed) stays
  // the generic, not-found-shaped refusal: naming *that* reason would be
  // an existence oracle this instructor has no other way to probe.
  it('refuses a personId belonging to another organization identically to any other not-found (TEN-5)', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const { organizationId: otherOrg } = seedOrganizationWithCourse(testDb.db)
    const foreignStudent = seedDiscordOnlyStudent(otherOrg, testDb.db)

    await expect(
      dispatch(
        exportTranscriptAction,
        { courseId: course.id, personId: foreignStudent.id },
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

  it('does not refuse a whole-course export just because one of its students has no verified address', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    // A Discord-only student exists in the course, but the export names no
    // single student — this *action's* own refusal does not apply (this
    // file's own module comment). The exported *file* still carries that
    // student's own messages, under a per-export pseudonym rather than
    // omitted — `apps/worker`'s own handler test proves that half, not
    // this one.
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

describe('transcripts.listAccessLog (ADMIN-2)', () => {
  it('an owner reads the log, most recent first, with a display name resolved for the actor and the student — never an email', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const student = people.createPerson(
      organizationId,
      { displayName: 'Alice' },
      testDb.db
    )
    seedMessage(organizationId, course.id, student.id, 'Hi!', testDb.db)

    // Two reads write two ADMIN-2 rows through the exact same audited path
    // ADMIN-1's own panel screen uses — an unfiltered read, then a
    // student-filtered one.
    await dispatch(
      readTranscriptAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    await dispatch(
      readTranscriptAction,
      { courseId: course.id, personId: student.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    const result = await dispatch(
      listTranscriptAccessLogAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    expect(result).toHaveLength(2)
    // Most recent first — the student-filtered read.
    expect(result[0]).toMatchObject({
      actorAccountId: ownerId,
      personId: student.id,
      personDisplayName: 'Alice',
      kind: 'read',
    })
    // The unfiltered read names nobody in particular.
    expect(result[1]).toMatchObject({
      actorAccountId: ownerId,
      personId: null,
      personDisplayName: null,
      kind: 'read',
    })
    expect(result.every((entry) => entry.actorDisplayName.length > 0)).toBe(
      true
    )
    // Never an email — the owner's own account carries one
    // (`seedOrganizationWithCourse`'s own `${randomUUID()}@example.edu`),
    // and it must not reach this response by any field.
    expect(JSON.stringify(result)).not.toMatch(/@example\.edu/)
  })

  // The defect this slice fixes: before this action existed, an audit found
  // `listAccessLogForCourse` had zero callers anywhere outside a test
  // (`docs/ROADMAP.md`'s own audit note) — an owner had no way to read this
  // back at all. This is that read, proven end to end through `dispatch`.
  it('refuses a non-owner membership (ADMIN-2 is restricted to an owner)', async () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb.db)
    const instructor = accounts.createAccount(
      organizationId,
      {
        email: `${randomUUID()}@example.edu`,
        displayName: 'Instructor',
        role: 'instructor',
      },
      testDb.db
    )

    await expect(
      dispatch(
        listTranscriptAccessLogAction,
        { courseId: course.id },
        { organizationId, db: testDb.db, accountId: instructor.id }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it('refuses when dispatch was given no accountId', async () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb.db)

    await expect(
      dispatch(
        listTranscriptAccessLogAction,
        { courseId: course.id },
        { organizationId, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it('refuses a course belonging to another organization (TEN-5), not-found-shaped', async () => {
    testDb = createTestDatabase()
    const { ownerId, course } = seedOrganizationWithCourse(testDb.db)
    const { organizationId: otherOrg } = seedOrganizationWithCourse(testDb.db)

    await expect(
      dispatch(
        listTranscriptAccessLogAction,
        { courseId: course.id },
        { organizationId: otherOrg, db: testDb.db, accountId: ownerId }
      )
    ).rejects.toThrow(ActionRefusedError)
  })
})
