/**
 * ENRL-2, ENRL-6, ENRL-9, WEB-22: `enrolments.listForPerson`,
 * `.checkAccess`, `.end`, `.reinstate` and `.listForCourse`.
 */

import { accounts, enrolments, people } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import {
  checkEnrolmentAccessAction,
  endEnrolmentAction,
  listEnrolmentsForCourseAction,
  listEnrolmentsForPersonAction,
  reinstateEnrolmentAction,
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
    if (!enrolment) throw new Error('setup failed: no enrolment')

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
    if (!enrolment) throw new Error('setup failed: no enrolment')

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

  // --- ENRL-9: enrolments.reinstate ---------------------------------------

  it('enrolments.reinstate restores access after enrolments.end removed it, and records who and when', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const person = people.createPerson(organizationId, {}, testDb.db)
    const enrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    if (!enrolment) throw new Error('setup failed: no enrolment')

    await dispatch(
      endEnrolmentAction,
      { enrolmentId: enrolment.id },
      { organizationId, db: testDb.db }
    )
    await expect(
      dispatch(
        checkEnrolmentAccessAction,
        { personId: person.id, courseId: course.id },
        { organizationId, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)

    const result = await dispatch(
      reinstateEnrolmentAction,
      { enrolmentId: enrolment.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    expect(result).toEqual({ reinstated: true })

    const access = await dispatch(
      checkEnrolmentAccessAction,
      { personId: person.id, courseId: course.id },
      { organizationId, db: testDb.db }
    )
    expect(access).toEqual({ courseId: course.id, personId: person.id })
    expect(
      enrolments.getEnrolment(organizationId, enrolment.id, testDb.db)
    ).toMatchObject({
      reinstatedByAccountId: ownerId,
      reinstatedAt: expect.any(Number),
    })
  })

  it('enrolments.reinstate refuses without an authenticated accountId — never recorded as reinstated by nobody', async () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb.db)
    const person = people.createPerson(organizationId, {}, testDb.db)
    const enrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    if (!enrolment) throw new Error('setup failed: no enrolment')
    await dispatch(
      endEnrolmentAction,
      { enrolmentId: enrolment.id },
      { organizationId, db: testDb.db }
    )

    // No `accountId` in the dispatch context at all — the same shape a
    // caller with no authenticated session would leave `dispatch` (`dispatch.ts`'s
    // own `DispatchContext.accountId` doc comment).
    await expect(
      dispatch(
        reinstateEnrolmentAction,
        { enrolmentId: enrolment.id },
        { organizationId, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)

    expect(
      enrolments.getEnrolment(organizationId, enrolment.id, testDb.db)
    ).toMatchObject({
      endedAt: expect.any(Number),
      reinstatedByAccountId: null,
    })
  })

  // Must-fix (rework): ENRL-7 admits anyone a course is taught through by
  // any membership role, including the lowest (`assistant`) — so a
  // membership in this organization is not proof the caller is a stranger
  // to the enrolment being reinstated. Reproduces the exact attack both
  // reviewers found over HTTP, directly at the dispatch layer: an account
  // that holds an ordinary membership here, and whose own `web` identity is
  // separately connected to the exact person the enrolment names, must
  // still be refused.
  it('enrolments.reinstate refuses when the caller is connected to the exact person the enrolment names, even holding a membership here', async () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb.db)
    const person = people.createPerson(organizationId, {}, testDb.db)
    const enrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    if (!enrolment) throw new Error('setup failed: no enrolment')
    await dispatch(
      endEnrolmentAction,
      { enrolmentId: enrolment.id },
      { organizationId, db: testDb.db }
    )

    // An ordinary membership — never a stranger — in this same
    // organization, standing in for a TA whose own, separate enrolment
    // (this one) was ended.
    const assistant = accounts.createAccount(
      organizationId,
      {
        email: 'assistant@example.edu',
        displayName: 'Assistant',
        role: 'assistant',
      },
      testDb.db
    )
    const connected = people.connectIdentity(
      organizationId,
      person.id,
      { surface: 'web', externalId: assistant.id },
      testDb.db
    )
    if (!connected) throw new Error('setup failed: connectIdentity refused')

    await expect(
      dispatch(
        reinstateEnrolmentAction,
        { enrolmentId: enrolment.id },
        { organizationId, db: testDb.db, accountId: assistant.id }
      )
    ).rejects.toThrow(ActionRefusedError)

    expect(
      enrolments.getEnrolment(organizationId, enrolment.id, testDb.db)
    ).toMatchObject({
      endedAt: expect.any(Number),
      reinstatedByAccountId: null,
      reinstatedAt: null,
    })
  })

  // The same membership, reinstating a *different* person's enrolment, is
  // not refused — the self-check names exactly the caller's own connected
  // person, not "any enrolment this account could plausibly reach."
  it('enrolments.reinstate still succeeds for a member reinstating a different person', async () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb.db)
    const student = people.createPerson(organizationId, {}, testDb.db)
    const enrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: student.id },
      testDb.db
    )
    if (!enrolment) throw new Error('setup failed: no enrolment')
    await dispatch(
      endEnrolmentAction,
      { enrolmentId: enrolment.id },
      { organizationId, db: testDb.db }
    )

    const assistant = accounts.createAccount(
      organizationId,
      {
        email: 'assistant2@example.edu',
        displayName: 'Assistant',
        role: 'assistant',
      },
      testDb.db
    )
    // No `connectIdentity` call at all here — this account is not connected
    // to `student`, or to anyone.

    const result = await dispatch(
      reinstateEnrolmentAction,
      { enrolmentId: enrolment.id },
      { organizationId, db: testDb.db, accountId: assistant.id }
    )
    expect(result).toEqual({ reinstated: true })
    expect(
      enrolments.getEnrolment(organizationId, enrolment.id, testDb.db)
    ).toMatchObject({ endedAt: null, reinstatedByAccountId: assistant.id })
  })

  it('enrolments.reinstate on an enrolment that is not ended is a no-op', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )
    const person = people.createPerson(organizationId, {}, testDb.db)
    const enrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    if (!enrolment) throw new Error('setup failed: no enrolment')

    const result = await dispatch(
      reinstateEnrolmentAction,
      { enrolmentId: enrolment.id },
      { organizationId, db: testDb.db, accountId: ownerId }
    )
    expect(result).toEqual({ reinstated: true })
    // Never ended, so nothing to reinstate — the row is untouched.
    expect(
      enrolments.getEnrolment(organizationId, enrolment.id, testDb.db)
    ).toMatchObject({ reinstatedByAccountId: null, reinstatedAt: null })
  })

  it("enrolments.reinstate refuses another organization's enrolment (TEN-5)", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA, course: courseA } =
      seedOrganizationWithCourse(testDb.db)
    const { organizationId: orgB, ownerId: ownerB } =
      seedOrganizationWithCourse(testDb.db)
    const person = people.createPerson(orgA, {}, testDb.db)
    const enrolment = enrolments.enrolViaRoster(
      orgA,
      { courseId: courseA.id, personId: person.id },
      testDb.db
    )
    if (!enrolment) throw new Error('setup failed: no enrolment')
    await dispatch(
      endEnrolmentAction,
      { enrolmentId: enrolment.id },
      { organizationId: orgA, db: testDb.db }
    )

    await expect(
      dispatch(
        reinstateEnrolmentAction,
        { enrolmentId: enrolment.id },
        { organizationId: orgB, db: testDb.db, accountId: ownerB }
      )
    ).rejects.toThrow(ActionRefusedError)

    expect(
      enrolments.getActiveEnrolment(orgA, courseA.id, person.id, testDb.db)
    ).toBeUndefined()
  })

  // --- WEB-22: enrolments.listForCourse -----------------------------------

  it('enrolments.listForCourse lists both an active and an ended enrolment', async () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb.db)
    const activePerson = people.createPerson(organizationId, {}, testDb.db)
    const endedPerson = people.createPerson(organizationId, {}, testDb.db)
    enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: activePerson.id },
      testDb.db
    )
    const endedEnrolment = enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: endedPerson.id },
      testDb.db
    )
    if (!endedEnrolment) throw new Error('setup failed: no enrolment')
    enrolments.endEnrolment(organizationId, endedEnrolment.id, testDb.db)

    const listed = await dispatch(
      listEnrolmentsForCourseAction,
      { courseId: course.id },
      { organizationId, db: testDb.db }
    )

    expect(listed.map((row) => row.personId).sort()).toEqual(
      [activePerson.id, endedPerson.id].sort()
    )
  })

  it("enrolments.listForCourse refuses another organization's course, byte-identically to a missing one (TEN-5)", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA, course: courseA } =
      seedOrganizationWithCourse(testDb.db)
    const { organizationId: orgB } = seedOrganizationWithCourse(testDb.db)

    const foreignError: unknown = await dispatch(
      listEnrolmentsForCourseAction,
      { courseId: courseA.id },
      { organizationId: orgB, db: testDb.db }
    ).catch((error: unknown) => error)
    const missingError: unknown = await dispatch(
      listEnrolmentsForCourseAction,
      { courseId: 'does-not-exist' },
      { organizationId: orgA, db: testDb.db }
    ).catch((error: unknown) => error)

    expect(foreignError).toBeInstanceOf(ActionRefusedError)
    expect(missingError).toBeInstanceOf(ActionRefusedError)
    expect(serializeError(foreignError)).toBe(serializeError(missingError))
  })
})
