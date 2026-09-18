/**
 * `courseApproval.notifyPending` (ADMIN-14, `docs/SPEC.md` §45) — against a
 * real, throwaway database and `@bloombot/auth`'s `RecordingEmailSender`.
 * Fails without this slice's code: before it, `apps/worker` registered no
 * `courseApproval.notifyPending` job kind at all, and nothing told an
 * operator a course had landed pending.
 */

import { randomUUID } from 'node:crypto'

import {
  accounts,
  courseApproval,
  courses,
  jobs,
  organizations,
  projects,
} from '@bloombot/db'
import { RecordingEmailSender } from '@bloombot/auth'
import { HandlerRegistry, runNextJob, type RetryPolicy } from '@bloombot/jobs'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createCourseApprovalNotificationHandler,
  COURSE_APPROVAL_NOTIFY_PENDING_JOB_KIND,
} from '../../src/handlers/course-approval-notifications.js'
import { buildCourseApprovalConsoleLink } from '../../src/course-approval-link.js'
import { createFakeLogger } from '../helpers/fake-logger.js'
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js'

const PUBLIC_APP_URL = 'https://bloombot.example'
const SUPPORT_CONTACT = 'support@bloombot.example'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

const retryPolicy: RetryPolicy = { baseDelayMs: 1000, backoffFactor: 2 }

/** A pending course, its project, its organization and one active owner — the smallest graph this handler's own read needs. */
function seedPendingCourse(db: TestDatabase['db']) {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Test Org', isPersonal: false },
    db
  )
  const owner = accounts.createAccount(
    organizationId,
    { email: 'owner@example.edu', displayName: 'Owner', role: 'owner' },
    db
  )
  const project = projects.createProject(
    organizationId,
    { name: 'Fall 2026' },
    db
  )
  const result = courses.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: 'Web Design',
      enabled: true,
      adminsRole: 'admins-wd-fa26',
      studentsRole: 'students-wd-fa26',
      categories: [],
    },
    db
  )
  if (!result.ok) throw new Error('setup failed: unexpected conflict')
  return {
    organizationId,
    projectName: project.name,
    organizationName: 'Test Org',
    ownerEmail: owner.email,
    courseId: result.course.id,
    courseTitle: result.course.title,
  }
}

async function runNotifyJob(db: TestDatabase['db'], registry: HandlerRegistry) {
  return runNextJob({
    db,
    logger: createFakeLogger(),
    handlers: registry,
    owner: 'worker-1',
    leaseMs: 60_000,
    handlerTimeoutMs: 60_000,
    retryPolicy,
  })
}

describe('courseApproval.notifyPending handler', () => {
  it('emails the support address naming the course, its project, its organization, its owner and the console link', async () => {
    testDb = createTestDatabase()
    const seeded = seedPendingCourse(testDb.db)
    const emailSender = new RecordingEmailSender()

    const handlers = new HandlerRegistry()
    handlers.register(
      COURSE_APPROVAL_NOTIFY_PENDING_JOB_KIND,
      createCourseApprovalNotificationHandler({
        emailSender,
        supportContact: SUPPORT_CONTACT,
        publicAppUrl: PUBLIC_APP_URL,
        logger: createFakeLogger(),
      })
    )
    jobs.enqueueJob(
      seeded.organizationId,
      {
        kind: COURSE_APPROVAL_NOTIFY_PENDING_JOB_KIND,
        payload: { courseId: seeded.courseId },
        maxAttempts: 3,
      },
      testDb.db
    )

    const result = await runNotifyJob(testDb.db, handlers)
    expect(result.outcome).toBe('succeeded')

    expect(emailSender.sent).toHaveLength(1)
    const sent = emailSender.sent[0]!
    expect(sent.to).toBe(SUPPORT_CONTACT)
    expect(sent.subject).toContain(seeded.courseTitle)
    expect(sent.body).toContain(seeded.courseTitle)
    expect(sent.body).toContain(seeded.projectName)
    expect(sent.body).toContain(seeded.organizationName)
    expect(sent.body).toContain(seeded.ownerEmail)
    expect(sent.body).toContain(
      buildCourseApprovalConsoleLink(PUBLIC_APP_URL, seeded.courseId)
    )
  })

  it('sends nothing, and still succeeds, when SUPPORT_CONTACT is not configured', async () => {
    testDb = createTestDatabase()
    const seeded = seedPendingCourse(testDb.db)
    const emailSender = new RecordingEmailSender()

    const handlers = new HandlerRegistry()
    handlers.register(
      COURSE_APPROVAL_NOTIFY_PENDING_JOB_KIND,
      createCourseApprovalNotificationHandler({
        emailSender,
        supportContact: '',
        publicAppUrl: PUBLIC_APP_URL,
        logger: createFakeLogger(),
      })
    )
    jobs.enqueueJob(
      seeded.organizationId,
      {
        kind: COURSE_APPROVAL_NOTIFY_PENDING_JOB_KIND,
        payload: { courseId: seeded.courseId },
        maxAttempts: 3,
      },
      testDb.db
    )

    const result = await runNotifyJob(testDb.db, handlers)
    expect(result.outcome).toBe('succeeded')
    expect(emailSender.sent).toHaveLength(0)
  })

  it('sends nothing, and still succeeds, when the course has since been approved', async () => {
    testDb = createTestDatabase()
    const seeded = seedPendingCourse(testDb.db)
    // An administrator approved it while the job sat in the queue.
    courseApproval.approveCourse(
      seeded.organizationId,
      seeded.courseId,
      null,
      'approve',
      Date.now(),
      testDb.db
    )
    const emailSender = new RecordingEmailSender()

    const handlers = new HandlerRegistry()
    handlers.register(
      COURSE_APPROVAL_NOTIFY_PENDING_JOB_KIND,
      createCourseApprovalNotificationHandler({
        emailSender,
        supportContact: SUPPORT_CONTACT,
        publicAppUrl: PUBLIC_APP_URL,
        logger: createFakeLogger(),
      })
    )
    jobs.enqueueJob(
      seeded.organizationId,
      {
        kind: COURSE_APPROVAL_NOTIFY_PENDING_JOB_KIND,
        payload: { courseId: seeded.courseId },
        maxAttempts: 3,
      },
      testDb.db
    )

    const result = await runNotifyJob(testDb.db, handlers)
    expect(result.outcome).toBe('succeeded')
    expect(emailSender.sent).toHaveLength(0)
  })
})
