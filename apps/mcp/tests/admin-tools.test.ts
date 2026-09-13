/**
 * MCP-9: `courses.listAdministered`'s own dispatch logic, exercised with no
 * transport at all — `call-tool.test.ts`'s own module comment describes the
 * identical shape for the action catalog, and `chat-tools.test.ts` is this
 * file's own twin for `chat-tools.ts`'s two tools.
 */

import { memberships } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import { listAdministeredCourses } from '../src/admin-tools.js'
import {
  connectAccountTo,
  seedCourse,
  seedEnrolledCourse,
  seedSecondOrganizationForAccount,
  seedSignedInAccount,
} from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('courses.listAdministered (MCP-9)', () => {
  it('sees every course in every organization it holds an active membership in', () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const { courseId: firstCourseId } = seedCourse(
      testDb.db,
      caller.organizationId,
      { title: 'First Org Course' }
    )

    const secondOrganizationId = seedSecondOrganizationForAccount(
      testDb.db,
      caller.accountId
    )
    const { courseId: secondCourseId } = seedCourse(
      testDb.db,
      secondOrganizationId,
      { title: 'Second Org Course' }
    )

    const administered = listAdministeredCourses(caller.accountId, testDb.db)

    expect(administered.map((entry) => entry.courseId).sort()).toEqual(
      [firstCourseId, secondCourseId].sort()
    )
    // The organization and project are named too — every other tool on the
    // surface needs the organizationId to act at all (MCP-3), and this is
    // the one place it is discoverable.
    const first = administered.find((entry) => entry.courseId === firstCourseId)
    expect(first).toMatchObject({
      organizationId: caller.organizationId,
      courseTitle: 'First Org Course',
    })
    expect(first?.organizationName).toBeTruthy()
    expect(first?.projectId).toBeTruthy()
    expect(first?.projectName).toBeTruthy()
  })

  it('does not see a course through an enrolment alone — being enrolled is not authority to administer', () => {
    testDb = createTestDatabase()
    // The organization's own owner — seeds a course, never used to
    // authenticate the call below.
    const owner = seedSignedInAccount(testDb.db)
    const { courseId, discordPersonId } = seedEnrolledCourse(
      testDb.db,
      owner.organizationId
    )
    // A student: a connected person and a real enrolment in `owner`'s
    // organization, but no membership there at all — exactly the account
    // `chat.listCourses` (MCP-8) already admits.
    const student = seedSignedInAccount(testDb.db)
    connectAccountTo(
      testDb.db,
      owner.organizationId,
      student.accountId,
      discordPersonId
    )

    const administered = listAdministeredCourses(student.accountId, testDb.db)

    expect(administered).toEqual([])
    // Not merely "this one course is absent" — this account reaches the
    // organization through no membership at all, so nothing from it appears.
    expect(courseId).toBeTruthy()
  })

  it('an account with no active membership anywhere gets an empty result, not an error', () => {
    testDb = createTestDatabase()
    // `seedSignedInAccount` always grants a membership in its own fresh
    // organization (a real account needs one to exist at all) — `assistant`,
    // not `owner`, so the last-owner invariant (`memberships.ts`'s own
    // `revokeMembership` doc comment) does not refuse revoking this
    // account's only membership, leaving a real account with genuinely none.
    const caller = seedSignedInAccount(testDb.db, { role: 'assistant' })
    const revoked = memberships.revokeMembership(
      caller.organizationId,
      { accountId: caller.accountId, revokedByAccountId: caller.accountId },
      testDb.db
    )
    if (!revoked) throw new Error('setup failed: could not revoke membership')

    const administered = listAdministeredCourses(caller.accountId, testDb.db)

    expect(administered).toEqual([])
  })

  it('never throws or leaks for an id that names no account at all', () => {
    testDb = createTestDatabase()
    expect(
      listAdministeredCourses('a-fully-unknown-account-id', testDb.db)
    ).toEqual([])
  })
})
