/**
 * ENRL-2, ENRL-6: `enrolments.listForPerson`, `.checkAccess` and `.end`.
 */

import { enrolments, people } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import {
  checkEnrolmentAccessAction,
  endEnrolmentAction,
  listEnrolmentsForPersonAction,
} from '../src/actions/enrolments.js'
import { dispatch } from '../src/dispatch.js'
import { ActionRefusedError } from '../src/errors.js'
import { seedOrganizationWithCourse } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Everything about an error that could differ between two refusals — the same helper `refusal-identity.test.ts` uses. */
function serializeError(error: unknown) {
  if (!(error instanceof Error)) throw new Error('expected an Error')
  return JSON.stringify({
    name: error.name,
    message: error.message,
    code: (error as ActionRefusedError).code,
  })
}

describe('enrolments.listForPerson/.checkAccess/.end (ENRL-2, ENRL-6)', () => {
  it("lists only a person's own enrolled courses", async () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb.db)
    const person = people.createPerson(organizationId, {}, testDb.db)
    enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )

    const listed = await dispatch(
      listEnrolmentsForPersonAction,
      { personId: person.id },
      { organizationId, db: testDb.db }
    )

    expect(listed.map((c) => c.id)).toEqual([course.id])
  })

  it('checkAccess succeeds for an enrolled course', async () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb.db)
    const person = people.createPerson(organizationId, {}, testDb.db)
    enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )

    const result = await dispatch(
      checkEnrolmentAccessAction,
      { personId: person.id, courseId: course.id },
      { organizationId, db: testDb.db }
    )

    expect(result).toEqual({ courseId: course.id, personId: person.id })
  })

  it('checkAccess refuses a course the person is not enrolled in, byte-identically to a missing course', async () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb.db)
    const person = people.createPerson(organizationId, {}, testDb.db)
    // Deliberately no enrolment created.

    const notEnrolledError: unknown = await dispatch(
      checkEnrolmentAccessAction,
      { personId: person.id, courseId: course.id },
      { organizationId, db: testDb.db }
    ).catch((error: unknown) => error)

    const missingCourseError: unknown = await dispatch(
      checkEnrolmentAccessAction,
      { personId: person.id, courseId: 'does-not-exist' },
      { organizationId, db: testDb.db }
    ).catch((error: unknown) => error)

    expect(notEnrolledError).toBeInstanceOf(ActionRefusedError)
    expect(missingCourseError).toBeInstanceOf(ActionRefusedError)
    expect(serializeError(notEnrolledError)).toBe(
      serializeError(missingCourseError)
    )
  })

  it('ending an enrolment stops the person from passing checkAccess', async () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb.db)
    const person = people.createPerson(organizationId, {}, testDb.db)
    const enrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )

    const result = await dispatch(
      endEnrolmentAction,
      { enrolmentId: enrolment.id },
      { organizationId, db: testDb.db }
    )
    expect(result).toEqual({ ended: true })

    await expect(
      dispatch(
        checkEnrolmentAccessAction,
        { personId: person.id, courseId: course.id },
        { organizationId, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)
  })

  it("enrolments.end refuses another organization's enrolment", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA, course: courseA } =
      seedOrganizationWithCourse(testDb.db)
    const { organizationId: orgB } = seedOrganizationWithCourse(testDb.db)
    const person = people.createPerson(orgA, {}, testDb.db)
    const enrolment = enrolments.enrolViaRoster(
      orgA,
      { courseId: courseA.id, personId: person.id },
      testDb.db
    )

    await expect(
      dispatch(
        endEnrolmentAction,
        { enrolmentId: enrolment.id },
        { organizationId: orgB, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)

    expect(
      enrolments.getActiveEnrolment(orgA, courseA.id, person.id, testDb.db)
    ).toBeDefined()
  })
})
