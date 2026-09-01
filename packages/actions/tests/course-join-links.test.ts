/**
 * ENRL-3, ENRL-4: `courseJoinLinks.create`/`.revoke` (dispatched actions)
 * and `redeemCourseJoinLink` (a plain function — see that file's own module
 * comment for why it is not dispatched).
 */

import { enrolments, people } from '@bloombot/db'
import { createHash } from 'node:crypto'
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
    // The row this action wrote never contains the plaintext — its own
    // SHA-256 hash instead. Cheap-fix 8: asserting only `not.toBe(created.secret)`
    // (the previous version of this test) passes for *any* transformation of
    // the secret, including `secret + '!'` — comparing against the real hash
    // is what actually pins down what `hashSecret` (module-private in
    // `../src/actions/course-join-links.js`) computes.
    const stored = testDb.db.$client
      .prepare(
        'select secret_hash as secretHash from course_join_links where id = ?'
      )
      .get(created.linkId) as { secretHash: string } | undefined
    expect(stored?.secretHash).toBe(
      createHash('sha256').update(created.secret).digest('hex')
    )
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

  // Cheap-fix 9: a join link is deliberately multi-use — "one link, a whole
  // class" (this file's own module comment on ENRL-3) — so two different
  // people redeeming the same still-live link must each be admitted
  // independently, not just the first.
  it('a live link admits more than one person, each independently', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const first = people.createPerson(organizationId, {}, testDb.db)
    const second = people.createPerson(organizationId, {}, testDb.db)

    const created = await dispatch(
      createCourseJoinLinkAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    const firstEnrolment = redeemCourseJoinLink(
      created.secret,
      first.id,
      testDb.db
    )
    const secondEnrolment = redeemCourseJoinLink(
      created.secret,
      second.id,
      testDb.db
    )

    expect(firstEnrolment?.personId).toBe(first.id)
    expect(secondEnrolment?.personId).toBe(second.id)
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        first.id,
        testDb.db
      )
    ).toBeDefined()
    expect(
      enrolments.getActiveEnrolment(
        organizationId,
        course.id,
        second.id,
        testDb.db
      )
    ).toBeDefined()
  })

  // Rework finding 7: a link created already expired reports success but
  // can never be redeemed — refused up front instead. Fails without the
  // fix: before `createInputSchema`'s own `.refine`, this call succeeded.
  it('refuses creating a join link whose expiresAt is already in the past', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )

    await expect(
      dispatch(
        createCourseJoinLinkAction,
        { courseId: course.id, expiresAt: Date.now() - 1000 },
        { organizationId, db: testDb.db, accountId: ownerId }
      )
    ).rejects.toThrow()
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
