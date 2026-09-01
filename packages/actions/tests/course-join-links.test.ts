/**
 * ENRL-3, ENRL-4: `courseJoinLinks.create`/`.revoke` (dispatched actions)
 * and `redeemCourseJoinLink` (a plain function — see that file's own module
 * comment for why it is not dispatched).
 */

import { enrolments, people } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createCourseJoinLinkAction,
  redeemCourseJoinLink,
  revokeCourseJoinLinkAction,
} from '../src/actions/course-join-links.js'
import { dispatch } from '../src/dispatch.js'
import { ActionRefusedError } from '../src/errors.js'
import { seedOrganizationWithCourse } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('courseJoinLinks.create/.revoke, redeemCourseJoinLink (ENRL-3, ENRL-4)', () => {
  it('creating returns the secret once, and the stored row never carries it', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )

    const created = await dispatch(
      createCourseJoinLinkAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    expect(created.secret).toBeTruthy()
    expect(JSON.stringify(created)).toContain(created.secret)
    // The row this action wrote never contains the plaintext — only its
    // hash — the same assertion `sign-in-tokens.test.ts` runs for AUTH-1.
    const stored = testDb.db.$client
      .prepare(
        'select secret_hash as secretHash from course_join_links where id = ?'
      )
      .get(created.linkId) as { secretHash: string } | undefined
    expect(stored?.secretHash).not.toBe(created.secret)
  })

  it('redeeming the secret this action returned enrols the redeemer', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const person = people.createPerson(organizationId, {}, testDb.db)

    const created = await dispatch(
      createCourseJoinLinkAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    const enrolment = redeemCourseJoinLink(created.secret, person.id, testDb.db)

    expect(enrolment?.source).toBe('join_link')
  })

  it('revoking stops the link admitting anyone new, but does not un-enrol somebody it already admitted', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const alreadyJoined = people.createPerson(organizationId, {}, testDb.db)
    const tooLate = people.createPerson(organizationId, {}, testDb.db)

    const created = await dispatch(
      createCourseJoinLinkAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    redeemCourseJoinLink(created.secret, alreadyJoined.id, testDb.db)

    await dispatch(
      revokeCourseJoinLinkAction,
      { linkId: created.linkId },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    expect(
      redeemCourseJoinLink(created.secret, tooLate.id, testDb.db)
    ).toBeUndefined()
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        alreadyJoined.id,
        testDb.db
      )
    ).toBeDefined()
  })

  it("revoking refuses another organization's link, identically to a missing one", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrganizationWithCourse(testDb.db)
    const {
      organizationId: orgB,
      ownerId: ownerB,
      course: courseB,
    } = seedOrganizationWithCourse(testDb.db)

    const created = await dispatch(
      createCourseJoinLinkAction,
      { courseId: courseB.id },
      { organizationId: orgB, db: testDb.db, accountId: ownerB }
    )

    await expect(
      dispatch(
        revokeCourseJoinLinkAction,
        { linkId: created.linkId },
        { organizationId: orgA, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })
})
