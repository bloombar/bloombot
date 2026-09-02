/**
 * Repository for `transcript_exports` (ADMIN-3, JOB-1) — against a real,
 * throwaway database (never `data/`, QA-2, QA-3). Indirectly exercised by
 * `packages/actions`', `apps/worker`'s and `apps/api`'s own test suites
 * already; this file is the direct, repo-level coverage those do not give
 * — in particular the deterministic ordering proof below, which none of
 * them can give reliably (see its own comment).
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import {
  accounts,
  courses,
  organizations,
  projects,
  schema,
  transcriptExports,
} from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** One organization, one course, one requester — enough for an export row to attach to. */
function seedCourseWithRequester(db: TestDatabase['db']) {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Org A', isPersonal: false },
    db
  )
  const project = projects.createProject(
    organizationId,
    { name: 'Fall 2026' },
    db
  )
  const courseResult = courses.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: 'Web Design',
      filePrefix: 'wd',
      enabled: true,
      adminsRole: 'admins-wd',
      studentsRole: 'students-wd',
      categories: [],
    },
    db
  )
  if (!courseResult.ok) throw new Error('seed course creation failed')
  const requester = accounts.createAccount(
    organizationId,
    {
      email: `${randomUUID()}@example.edu`,
      displayName: 'Instructor',
      role: 'owner',
    },
    db
  )
  return { organizationId, courseId: courseResult.course.id, requester }
}

describe('transcriptExports.createPendingExport / getExport', () => {
  it('creates a pending row, scoped to organizationId (TEN-5)', () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, requester } = seedCourseWithRequester(
      testDb.db
    )

    const created = transcriptExports.createPendingExport(
      organizationId,
      { courseId, requestedByAccountId: requester.id },
      testDb.db
    )

    expect(created).toMatchObject({
      organizationId,
      courseId,
      requestedByAccountId: requester.id,
      status: 'pending',
      personId: null,
      filename: null,
    })

    const otherOrg = randomUUID()
    organizations.createOrganization(
      otherOrg,
      { name: 'Org B', isPersonal: false },
      testDb.db
    )
    expect(
      transcriptExports.getExport(otherOrg, created.id, testDb.db)
    ).toBeUndefined()
    expect(
      transcriptExports.getExport(organizationId, created.id, testDb.db)
    ).toMatchObject({ id: created.id })
  })
})

describe('transcriptExports.markExportReady / markExportFailed', () => {
  it('marks ready, carrying the file’s own filename/contentType/sizeBytes', () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, requester } = seedCourseWithRequester(
      testDb.db
    )
    const created = transcriptExports.createPendingExport(
      organizationId,
      { courseId, requestedByAccountId: requester.id },
      testDb.db
    )

    const ready = transcriptExports.markExportReady(
      organizationId,
      created.id,
      {
        filename: 'transcript.json',
        contentType: 'application/json',
        sizeBytes: 12,
      },
      testDb.db
    )

    expect(ready).toMatchObject({
      status: 'ready',
      filename: 'transcript.json',
      contentType: 'application/json',
      sizeBytes: 12,
    })
  })

  it('marks failed, carrying the reason', () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, requester } = seedCourseWithRequester(
      testDb.db
    )
    const created = transcriptExports.createPendingExport(
      organizationId,
      { courseId, requestedByAccountId: requester.id },
      testDb.db
    )

    const failed = transcriptExports.markExportFailed(
      organizationId,
      created.id,
      'disk full',
      testDb.db
    )

    expect(failed).toMatchObject({
      status: 'failed',
      failureReason: 'disk full',
    })
  })
})

describe('transcriptExports.listExportsForCourse — ordering', () => {
  // Also-fix of the ADMIN-1..5 rework: the *previous* version of this
  // ordering fix's own test (`packages/actions/tests/transcripts.test.ts`'s
  // own "most recent first") relied on two real, sequential `createPendingExport`
  // calls happening to land in different milliseconds — which they usually
  // do, but a reviewer measured roughly one failure in twelve runs against
  // a deliberately reverted `desc(createdAt)` implementation, meaning that
  // test would not reliably have caught a real regression. This test
  // instead constructs the tie directly — two rows with an *identical*
  // `createdAt`, inserted straight through the schema (bypassing
  // `createPendingExport`'s own `Date.now()`, which cannot be forced to
  // collide from the outside) — so the assertion is deterministic:
  // ordering by `createdAt` alone could return either row first; ordering
  // by `sequence` (this repo's own fix) cannot.
  it('orders by sequence, not createdAt alone, even when two rows share an identical createdAt', () => {
    testDb = createTestDatabase()
    const { organizationId, courseId, requester } = seedCourseWithRequester(
      testDb.db
    )
    const tiedCreatedAt = 1_700_000_000_000

    testDb.db
      .insert(schema.transcriptExports)
      .values({
        id: randomUUID(),
        organizationId,
        courseId,
        personId: null,
        requestedByAccountId: requester.id,
        status: 'pending',
        startAt: null,
        endAt: null,
        filename: null,
        contentType: null,
        sizeBytes: null,
        failureReason: null,
        sequence: 0,
        createdAt: tiedCreatedAt,
        updatedAt: tiedCreatedAt,
      })
      .run()
    const secondId = randomUUID()
    testDb.db
      .insert(schema.transcriptExports)
      .values({
        id: secondId,
        organizationId,
        courseId,
        personId: null,
        requestedByAccountId: requester.id,
        status: 'pending',
        startAt: null,
        endAt: null,
        filename: null,
        contentType: null,
        sizeBytes: null,
        failureReason: null,
        sequence: 1,
        createdAt: tiedCreatedAt,
        updatedAt: tiedCreatedAt,
      })
      .run()

    const listed = transcriptExports.listExportsForCourse(
      organizationId,
      courseId,
      testDb.db
    )

    expect(listed.map((row) => row.sequence)).toEqual([1, 0])
    expect(listed[0]?.id).toBe(secondId)
  })
})
