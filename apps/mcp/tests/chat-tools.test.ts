/**
 * MCP-8: `chat.listCourses`/`chat.ask`'s own dispatch logic, exercised with
 * no transport at all — `call-tool.test.ts`'s own module comment describes
 * the identical shape for the action catalog, and `chat-tools.ts`'s own
 * module comment is why these two tools are tested the same way but through
 * a different entry point (`listAskableCourses`/`askChatQuestion` directly,
 * never `callTool`).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { conversations, enrolments } from '@bloombot/db'
import type { Logger } from '@bloombot/logger'

import {
  askChatQuestion,
  isAccountLinked,
  listAskableCourses,
} from '../src/chat-tools.js'
import { FakeModelClient } from './helpers/fake-model-client.js'
import {
  connectAccountTo,
  connectAccountToFreshPerson,
  seedEnrolledCourse,
  seedSecondOrganizationForAccount,
  seedSignedInAccount,
} from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('chat-tools.ts (MCP-8)', () => {
  describe('chat.listCourses — across every organization the account can reach', () => {
    it('sees, across two organizations, exactly the courses admitted in each, and no others', () => {
      testDb = createTestDatabase()
      const caller = seedSignedInAccount(testDb.db, { role: 'instructor' })
      const { courseId: firstCourseId, discordPersonId } = seedEnrolledCourse(
        testDb.db,
        caller.organizationId
      )
      connectAccountTo(
        testDb.db,
        caller.organizationId,
        caller.accountId,
        discordPersonId
      )
      // A second course in the same organization this person is not
      // enrolled in, and which does not otherwise admit an unconnected
      // caller — proves this is not simply "every course in the org".
      seedEnrolledCourse(testDb.db, caller.organizationId, {
        enrol: false,
        answerUnenrolled: false,
      })

      const secondOrganizationId = seedSecondOrganizationForAccount(
        testDb.db,
        caller.accountId
      )
      const { courseId: secondCourseId } = seedEnrolledCourse(
        testDb.db,
        secondOrganizationId,
        { enrol: false }
      )
      connectAccountToFreshPerson(
        testDb.db,
        secondOrganizationId,
        caller.accountId
      )

      const listed = listAskableCourses(caller.accountId, testDb.db)
      expect(listed.map((c) => c.courseId).sort()).toEqual(
        [firstCourseId, secondCourseId].sort()
      )
    })

    // The no-leak test — against `createCourse`'s own real defaults, not
    // pinned flags (this slice's own brief).
    it('a non-member connected person sees only their enrolments', () => {
      testDb = createTestDatabase()
      const owner = seedSignedInAccount(testDb.db)
      const { courseId, discordPersonId } = seedEnrolledCourse(
        testDb.db,
        owner.organizationId
      )
      // A second course in the same organization, left at real defaults,
      // that this person holds no enrolment in.
      seedEnrolledCourse(testDb.db, owner.organizationId, { enrol: false })

      // A stranger to `owner`'s organization: their own account has no
      // membership there at all, only a connected person.
      const stranger = seedSignedInAccount(testDb.db)
      connectAccountTo(
        testDb.db,
        owner.organizationId,
        stranger.accountId,
        discordPersonId
      )

      const listed = listAskableCourses(stranger.accountId, testDb.db)
      expect(listed.map((c) => c.courseId)).toEqual([courseId])
    })

    it('an unlinked account (no connected person anywhere) is reported as not linked', () => {
      testDb = createTestDatabase()
      const caller = seedSignedInAccount(testDb.db)
      seedEnrolledCourse(testDb.db, caller.organizationId, { enrol: false })

      expect(isAccountLinked(caller.accountId, testDb.db)).toBe(false)
      expect(listAskableCourses(caller.accountId, testDb.db)).toEqual([])
    })
  })

  describe('chat.ask — the same admission rules, resolved fresh at call time', () => {
    it('an unlinked account is refused, naming the connect tool (via its own "unlinked" kind)', async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInAccount(testDb.db)
      const model = new FakeModelClient('unused')

      const result = await askChatQuestion(
        caller.accountId,
        { text: 'Anybody there?' },
        { db: testDb.db, model, logger: fakeLogger() }
      )

      expect(result.kind).toBe('unlinked')
      expect(model.calls).toHaveLength(0)
    })

    it('asking in an admitted course returns an answer and records a surface: mcp conversation', async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInAccount(testDb.db)
      const { courseId, discordPersonId } = seedEnrolledCourse(
        testDb.db,
        caller.organizationId
      )
      connectAccountTo(
        testDb.db,
        caller.organizationId,
        caller.accountId,
        discordPersonId
      )
      const model = new FakeModelClient('# Welcome\n\nAsk away.')

      const result = await askChatQuestion(
        caller.accountId,
        { courseId, text: 'What is on the syllabus?' },
        { db: testDb.db, model, logger: fakeLogger() }
      )

      expect(result.kind).toBe('answered')
      if (result.kind !== 'answered') throw new Error('expected answered')
      expect(result.text).toBe('# Welcome\n\nAsk away.')
      // The answer names the course it came from.
      expect(result.course.courseId).toBe(courseId)
      expect(result.course.courseTitle).toBe('Intro to Testing')

      const conversation = conversations.findExistingConversation(
        caller.organizationId,
        { courseId, personId: discordPersonId, surface: 'mcp' },
        testDb.db
      )
      expect(conversation).toBeDefined()
    })

    it('one admitted course, no courseId — answered in it directly', async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInAccount(testDb.db)
      const { courseId, discordPersonId } = seedEnrolledCourse(
        testDb.db,
        caller.organizationId
      )
      connectAccountTo(
        testDb.db,
        caller.organizationId,
        caller.accountId,
        discordPersonId
      )
      const model = new FakeModelClient('Sure, ask away.')

      const result = await askChatQuestion(
        caller.accountId,
        { text: 'Anybody there?' },
        { db: testDb.db, model, logger: fakeLogger() }
      )

      expect(result.kind).toBe('answered')
      if (result.kind !== 'answered') throw new Error('expected answered')
      expect(result.course.courseId).toBe(courseId)
    })

    it('several admitted courses, no courseId — refused with a listing naming no organization', async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInAccount(testDb.db)
      const first = seedEnrolledCourse(testDb.db, caller.organizationId)
      connectAccountTo(
        testDb.db,
        caller.organizationId,
        caller.accountId,
        first.discordPersonId
      )
      const secondOrganizationId = seedSecondOrganizationForAccount(
        testDb.db,
        caller.accountId
      )
      seedEnrolledCourse(testDb.db, secondOrganizationId, { enrol: false })
      connectAccountToFreshPerson(
        testDb.db,
        secondOrganizationId,
        caller.accountId
      )
      const model = new FakeModelClient('unused')

      const result = await askChatQuestion(
        caller.accountId,
        { text: 'Anybody there?' },
        { db: testDb.db, model, logger: fakeLogger() }
      )

      expect(result.kind).toBe('needs-course-selection')
      if (result.kind !== 'needs-course-selection') {
        throw new Error('expected needs-course-selection')
      }
      expect(result.choices).toHaveLength(2)
      expect(JSON.stringify(result.choices)).not.toContain('organizationId')
      expect(JSON.stringify(result.choices)).not.toContain(
        caller.organizationId
      )
      expect(model.calls).toHaveLength(0)
    })

    it('a refused courseId is not answered, lists the admitted ones, and does not reveal the refused course exists', async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInAccount(testDb.db, { role: 'instructor' })
      const admitted = seedEnrolledCourse(testDb.db, caller.organizationId)
      connectAccountTo(
        testDb.db,
        caller.organizationId,
        caller.accountId,
        admitted.discordPersonId
      )
      // A real course this account is *not* admitted to — left at real
      // defaults with no enrolment and no membership admitting it.
      const refused = seedEnrolledCourse(testDb.db, caller.organizationId, {
        enrol: false,
        answerUnenrolled: false,
      })
      const model = new FakeModelClient('unused')

      const result = await askChatQuestion(
        caller.accountId,
        { courseId: refused.courseId, text: 'Anybody there?' },
        { db: testDb.db, model, logger: fakeLogger() }
      )

      expect(result.kind).toBe('needs-course-selection')
      if (result.kind !== 'needs-course-selection') {
        throw new Error('expected needs-course-selection')
      }
      expect(result.choices.map((c) => c.courseId)).toEqual([admitted.courseId])
      expect(JSON.stringify(result.choices)).not.toContain(refused.courseId)
      expect(model.calls).toHaveLength(0)
      // "records nothing" (this slice's own brief) — no conversation was
      // ever opened for the refused course.
      expect(
        conversations.findExistingConversation(
          caller.organizationId,
          {
            courseId: refused.courseId,
            personId: refused.discordPersonId,
            surface: 'mcp',
          },
          testDb.db
        )
      ).toBeUndefined()
    })

    it('a nonexistent courseId is indistinguishable from a refused one', async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInAccount(testDb.db, { role: 'instructor' })
      const admitted = seedEnrolledCourse(testDb.db, caller.organizationId)
      connectAccountTo(
        testDb.db,
        caller.organizationId,
        caller.accountId,
        admitted.discordPersonId
      )
      const refused = seedEnrolledCourse(testDb.db, caller.organizationId, {
        enrol: false,
        answerUnenrolled: false,
      })
      const model = new FakeModelClient('unused')

      const refusedResult = await askChatQuestion(
        caller.accountId,
        { courseId: refused.courseId, text: 'x' },
        { db: testDb.db, model, logger: fakeLogger() }
      )
      const nonexistentResult = await askChatQuestion(
        caller.accountId,
        { courseId: 'course-does-not-exist', text: 'x' },
        { db: testDb.db, model, logger: fakeLogger() }
      )

      expect(refusedResult.kind).toBe('needs-course-selection')
      expect(nonexistentResult.kind).toBe('needs-course-selection')
      expect(refusedResult).toEqual(nonexistentResult)
    })

    it('an ended enrolment refuses, even with a membership and permissive course settings', async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInAccount(testDb.db, { role: 'instructor' })
      const { courseId, discordPersonId } = seedEnrolledCourse(
        testDb.db,
        caller.organizationId
      )
      connectAccountTo(
        testDb.db,
        caller.organizationId,
        caller.accountId,
        discordPersonId
      )
      const enrolment = enrolments.getActiveEnrolment(
        caller.organizationId,
        courseId,
        discordPersonId,
        testDb.db
      )
      if (!enrolment) throw new Error('test setup: no active enrolment')
      enrolments.endEnrolment(caller.organizationId, enrolment.id, testDb.db)
      const model = new FakeModelClient('unused')

      const result = await askChatQuestion(
        caller.accountId,
        { courseId, text: 'Anybody there?' },
        { db: testDb.db, model, logger: fakeLogger() }
      )

      expect(result.kind).toBe('needs-course-selection')
      expect(model.calls).toHaveLength(0)
    })

    it('admission self-enrol creates an enrolment with the same source the other surfaces write', async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInAccount(testDb.db, { role: 'instructor' })
      const { courseId } = seedEnrolledCourse(
        testDb.db,
        caller.organizationId,
        {
          enrol: false,
          answerUnenrolled: false,
          selfEnrolFromDiscord: true,
        }
      )
      const personId = connectAccountToFreshPerson(
        testDb.db,
        caller.organizationId,
        caller.accountId
      )
      const model = new FakeModelClient('Welcome aboard.')

      const result = await askChatQuestion(
        caller.accountId,
        { courseId, text: 'Anybody there?' },
        { db: testDb.db, model, logger: fakeLogger() }
      )

      expect(result.kind).toBe('answered')
      const enrolment = enrolments.getActiveEnrolment(
        caller.organizationId,
        courseId,
        personId,
        testDb.db
      )
      expect(enrolment).toBeDefined()
      expect(enrolment?.source).toBe('self_enrolment')
    })

    it('a declined enrolment write refuses rather than answering', async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInAccount(testDb.db, { role: 'instructor' })
      const { courseId } = seedEnrolledCourse(
        testDb.db,
        caller.organizationId,
        {
          enrol: false,
          answerUnenrolled: false,
          selfEnrolFromDiscord: true,
        }
      )
      connectAccountToFreshPerson(
        testDb.db,
        caller.organizationId,
        caller.accountId
      )
      const model = new FakeModelClient('unused')

      const spy = vi
        .spyOn(enrolments, 'enrolViaSelfEnrolment')
        .mockReturnValue(undefined)

      const result = await askChatQuestion(
        caller.accountId,
        { courseId, text: 'Anybody there?' },
        { db: testDb.db, model, logger: fakeLogger() }
      )

      spy.mockRestore()

      expect(result.kind).toBe('needs-course-selection')
      expect(model.calls).toHaveLength(0)
    })

    it('the list and the ask tool agree: every course listed can be asked in, and vice versa', async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInAccount(testDb.db, { role: 'instructor' })
      const enrolled = seedEnrolledCourse(testDb.db, caller.organizationId)
      connectAccountTo(
        testDb.db,
        caller.organizationId,
        caller.accountId,
        enrolled.discordPersonId
      )
      const memberAdmitted = seedEnrolledCourse(
        testDb.db,
        caller.organizationId,
        { enrol: false }
      )
      const refused = seedEnrolledCourse(testDb.db, caller.organizationId, {
        enrol: false,
        answerUnenrolled: false,
      })

      const listed = listAskableCourses(caller.accountId, testDb.db)
      const listedIds = listed.map((c) => c.courseId).sort()
      expect(listedIds).toEqual(
        [enrolled.courseId, memberAdmitted.courseId].sort()
      )
      expect(listedIds).not.toContain(refused.courseId)

      for (const courseId of listedIds) {
        const model = new FakeModelClient('ok')
        const result = await askChatQuestion(
          caller.accountId,
          { courseId, text: 'Anybody there?' },
          { db: testDb.db, model, logger: fakeLogger() }
        )
        expect(result.kind).toBe('answered')
      }

      const model = new FakeModelClient('unused')
      const refusedResult = await askChatQuestion(
        caller.accountId,
        { courseId: refused.courseId, text: 'Anybody there?' },
        { db: testDb.db, model, logger: fakeLogger() }
      )
      expect(refusedResult.kind).toBe('needs-course-selection')
    })

    // MCP-5 — the same daily allowance every other surface answers against.
    it('usage is metered the way the other surfaces meter it — a course at its own daily ceiling declines the next question', async () => {
      testDb = createTestDatabase()
      const caller = seedSignedInAccount(testDb.db)
      const { courseId, discordPersonId } = seedEnrolledCourse(
        testDb.db,
        caller.organizationId,
        { maxRequestsPerDay: 1 }
      )
      connectAccountTo(
        testDb.db,
        caller.organizationId,
        caller.accountId,
        discordPersonId
      )
      const model = new FakeModelClient('ok')

      const first = await askChatQuestion(
        caller.accountId,
        { courseId, text: 'One?' },
        { db: testDb.db, model, logger: fakeLogger() }
      )
      expect(first.kind).toBe('answered-last-request')

      const second = await askChatQuestion(
        caller.accountId,
        { courseId, text: 'Two?' },
        { db: testDb.db, model, logger: fakeLogger() }
      )
      expect(second.kind).toBe('declined-over-limit')
      expect(model.calls).toHaveLength(1)
    })
  })
})

function fakeLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
  } as unknown as Logger
}
