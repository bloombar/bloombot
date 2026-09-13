/**
 * MCP-9: `courses.listAdministered`'s own dispatch logic, exercised with no
 * transport at all — `call-tool.test.ts`'s own module comment describes the
 * identical shape for the action catalog, and `chat-tools.test.ts` is this
 * file's own twin for `chat-tools.ts`'s two tools.
 */

import { memberships, projects } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import { listAdministeredOrganizations } from '../src/admin-tools.js'
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

    const administered = listAdministeredOrganizations(
      caller.accountId,
      testDb.db
    )

    expect(administered.map((org) => org.organizationId).sort()).toEqual(
      [caller.organizationId, secondOrganizationId].sort()
    )
    // The organization and project are named too — every other tool on the
    // surface needs the organizationId to act at all (MCP-3), and this is
    // the one place it is discoverable.
    const first = administered.find(
      (org) => org.organizationId === caller.organizationId
    )
    expect(first?.organizationName).toBeTruthy()
    expect(first?.courses).toEqual([
      expect.objectContaining({
        courseId: firstCourseId,
        courseTitle: 'First Org Course',
      }),
    ])
    expect(first?.courses[0]?.projectId).toBeTruthy()
    expect(first?.courses[0]?.projectName).toBeTruthy()

    const second = administered.find(
      (org) => org.organizationId === secondOrganizationId
    )
    expect(second?.courses.map((c) => c.courseId)).toEqual([secondCourseId])
  })

  it('lists an organization it administers even when that organization has no courses yet — must-fix 1', () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    // No course seeded at all in this organization — the fresh,
    // just-created-organization case this fix exists for: `projects.create`
    // and `courses.save` both need this organizationId, and this tool is
    // the only place to learn it.
    const administered = listAdministeredOrganizations(
      caller.accountId,
      testDb.db
    )

    expect(administered).toEqual([
      {
        organizationId: caller.organizationId,
        organizationName: expect.any(String),
        courses: [],
      },
    ])
  })

  it("excludes a course whose project is archived, matching projects.listProjects's own default", () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const { projectId } = seedCourse(testDb.db, caller.organizationId, {
      title: 'Archived Course',
    })
    const changed = projects.archiveProject(
      caller.organizationId,
      projectId,
      testDb.db
    )
    if (changed === 0) throw new Error('setup failed: could not archive')

    const administered = listAdministeredOrganizations(
      caller.accountId,
      testDb.db
    )

    // The organization itself is still listed (must-fix 1's own guarantee)
    // — only its one, now-archived-away course is gone, not the whole
    // organization.
    expect(administered).toEqual([
      {
        organizationId: caller.organizationId,
        organizationName: expect.any(String),
        courses: [],
      },
    ])
  })

  it("an assistant-role membership counts as administering — D-110's own central claim, pinned directly", () => {
    testDb = createTestDatabase()
    // `assistant` — the narrowest of the three `MembershipRole`s, and the
    // one D-110 explicitly says is not filtered out: `call-tool.ts`'s own
    // membership gate already lets an `assistant` dispatch `courses.save`
    // through this same server, so a filter here would read stricter than
    // the writes it points at.
    const caller = seedSignedInAccount(testDb.db, { role: 'assistant' })
    const { courseId } = seedCourse(testDb.db, caller.organizationId, {
      title: 'Assistant-Administered Course',
    })

    const administered = listAdministeredOrganizations(
      caller.accountId,
      testDb.db
    )

    expect(
      administered
        .find((org) => org.organizationId === caller.organizationId)
        ?.courses.map((c) => c.courseId)
    ).toEqual([courseId])
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

    const administered = listAdministeredOrganizations(
      student.accountId,
      testDb.db
    )

    // `student` has its own, unrelated personal organization from
    // `seedSignedInAccount` (a real account needs a membership to exist at
    // all), so this is not "the whole list is empty" — it is that
    // `owner`'s own organization specifically never appears, because this
    // account reaches it through no membership at all (unlike the
    // zero-courses case above, where the account genuinely administers the
    // organization it appears under).
    expect(
      administered.some((org) => org.organizationId === owner.organizationId)
    ).toBe(false)
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

    const administered = listAdministeredOrganizations(
      caller.accountId,
      testDb.db
    )

    expect(administered).toEqual([])
  })

  it('never throws or leaks for an id that names no account at all', () => {
    testDb = createTestDatabase()
    expect(
      listAdministeredOrganizations('a-fully-unknown-account-id', testDb.db)
    ).toEqual([])
  })
})
