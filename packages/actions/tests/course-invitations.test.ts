/**
 * ROST-21, WEB-82: `courseInvitations.list` and `.revoke` — dispatched
 * actions, modelled on `course-join-links.test.ts`'s own shape.
 */

import { courseInvitations as invitationsRepo } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import {
  listCourseInvitationsAction,
  revokeCourseInvitationAction,
} from '../src/actions/course-invitations.js'
import { dispatch } from '../src/dispatch.js'
import { ActionRefusedError } from '../src/errors.js'
import { seedOrganizationWithCourse } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

function invite(orgId: string, courseId: string, email: string) {
  const result = invitationsRepo.upsertInvitation(
    orgId,
    { courseId, email, firstName: 'Ada', lastName: 'Lovelace' },
    testDb.db
  )
  if (!result) throw new Error('invitation refused')
  return result.invitation
}

describe('courseInvitations.list (WEB-82)', () => {
  it("lists a course's open invitations without internal columns", async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const invitation = invite(organizationId, course.id, 'ada@example.edu')

    const listed = await dispatch(
      listCourseInvitationsAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    expect(listed).toEqual([
      {
        id: invitation.id,
        email: 'ada@example.edu',
        firstName: 'Ada',
        lastName: 'Lovelace',
        createdAt: invitation.createdAt,
      },
    ])
  })

  it('refuses a course of another organization, as it does a missing one', async () => {
    testDb = createTestDatabase()
    const mine = seedOrganizationWithCourse(testDb.db)
    const theirs = seedOrganizationWithCourse(testDb.db)

    await expect(
      dispatch(
        listCourseInvitationsAction,
        { courseId: theirs.course.id },
        { organizationId: mine.organizationId, db: testDb.db }
      )
    ).rejects.toBeInstanceOf(ActionRefusedError)
  })
})

describe('courseInvitations.revoke (WEB-82)', () => {
  it('removes an open invitation, recording who did', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const invitation = invite(organizationId, course.id, 'ada@example.edu')

    const result = await dispatch(
      revokeCourseInvitationAction,
      { invitationId: invitation.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    expect(result).toEqual({ revoked: true })
    expect(
      invitationsRepo.listOpenInvitationsForCourse(
        organizationId,
        course.id,
        testDb.db
      )
    ).toEqual([])
  })

  it("refuses another organization's invitation, byte-identically to a missing one", async () => {
    testDb = createTestDatabase()
    const mine = seedOrganizationWithCourse(testDb.db)
    const theirs = seedOrganizationWithCourse(testDb.db)
    const foreign = invite(theirs.organizationId, theirs.course.id, 'a@x.edu')

    const errors: string[] = []
    for (const invitationId of [foreign.id, 'no-such-invitation']) {
      try {
        await dispatch(
          revokeCourseInvitationAction,
          { invitationId },
          {
            organizationId: mine.organizationId,
            db: testDb.db,
            accountId: mine.ownerId,
          }
        )
      } catch (error) {
        const refusal = error as ActionRefusedError
        errors.push(
          JSON.stringify({
            name: refusal.name,
            message: refusal.message,
            code: refusal.code,
          })
        )
      }
    }

    expect(errors).toHaveLength(2)
    expect(errors[0]).toBe(errors[1])
    // And the foreign invitation is untouched.
    expect(
      invitationsRepo.listOpenInvitationsForCourse(
        theirs.organizationId,
        theirs.course.id,
        testDb.db
      )
    ).toHaveLength(1)
  })

  it('refuses an invitation already removed', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const invitation = invite(organizationId, course.id, 'ada@example.edu')
    invitationsRepo.revokeInvitation(
      organizationId,
      invitation.id,
      ownerId,
      testDb.db
    )

    await expect(
      dispatch(
        revokeCourseInvitationAction,
        { invitationId: invitation.id },
        { organizationId, db: testDb.db, accountId: ownerId }
      )
    ).rejects.toBeInstanceOf(ActionRefusedError)
  })

  it('refuses a call with no authenticated account', async () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb.db)
    const invitation = invite(organizationId, course.id, 'ada@example.edu')

    await expect(
      dispatch(
        revokeCourseInvitationAction,
        { invitationId: invitation.id },
        { organizationId, db: testDb.db }
      )
    ).rejects.toBeInstanceOf(ActionRefusedError)
    expect(
      invitationsRepo.listOpenInvitationsForCourse(
        organizationId,
        course.id,
        testDb.db
      )
    ).toHaveLength(1)
  })
})
