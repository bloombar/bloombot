/**
 * SRV-12: `courseChannels.addCategory`/`.renameCategory`/`.removeCategory`/
 * `.addChannel`/`.updateChannel`/`.removeChannel` — dispatched actions, each
 * exercising the whole pipeline (schema, policy, `execute`), not just the
 * repo functions `../src/actions/course-channels.ts` calls. The repo's own
 * ordering, conflict and TEN-2 scoping tests live in
 * `packages/db/tests/courses.test.ts`; these tests are about what changes
 * when the same operations run through `dispatch`, one hop up the stack a
 * repo-level test cannot see: the input schema (`z.strictObject`, an
 * explicit `null` refused on `updateChannel`) and the policy's own
 * undifferentiated refusal for a foreign-organization id.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  addCourseCategoryAction,
  addCourseChannelAction,
  removeCourseCategoryAction,
  removeCourseChannelAction,
  renameCourseCategoryAction,
  updateCourseChannelAction,
} from '../src/actions/course-channels.js'
import { dispatch } from '../src/dispatch.js'
import { ActionInputError, ActionRefusedError } from '../src/errors.js'
import { seedOrganization, seedOrganizationWithCourse } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'
import { courses } from '@bloombot/db'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** A course, disabled (no PROJ-3 candidate set to worry about), with two categories and one channel each — enough siblings for "leaves everything else untouched" to mean something. */
function seedCourseWithTwoCategories(db: TestDatabase['db']) {
  const seeded = seedOrganizationWithCourse(db)
  courses.disableCourse(seeded.organizationId, seeded.course.id, db)
  const first = courses.addCourseCategory(
    seeded.organizationId,
    seeded.course.id,
    'GLOBAL',
    db
  )
  const second = courses.addCourseCategory(
    seeded.organizationId,
    seeded.course.id,
    'WEEK 1',
    db
  )
  if (!first?.ok || !second?.ok) throw new Error('setup failed')
  const channel = courses.addCourseChannel(
    seeded.organizationId,
    first.category.id,
    { name: 'announcements', adminsOnly: true },
    db
  )
  if (!channel) throw new Error('setup failed')
  return {
    organizationId: seeded.organizationId,
    ownerId: seeded.ownerId,
    categoryA: { ...first.category, channels: [channel] },
    categoryB: second.category,
  }
}

describe('courseChannels.addCategory', () => {
  it('appends a category to the course', async () => {
    testDb = createTestDatabase()
    const { organizationId, ownerId, course } = seedOrganizationWithCourse(
      testDb.db
    )

    const result = await dispatch(
      addCourseCategoryAction,
      { courseId: course.id, name: 'GLOBAL' },
      { organizationId, db: testDb.db, accountId: ownerId }
    )

    expect(result).toMatchObject({ name: 'GLOBAL', ordering: 0 })
  })

  it('refuses a courseId belonging to another organization with the undifferentiated ActionRefusedError (ACT-3)', async () => {
    testDb = createTestDatabase()
    const { course } = seedOrganizationWithCourse(testDb.db)
    const otherOrg = seedOrganization(testDb.db, 'Other Org')

    await expect(
      dispatch(
        addCourseCategoryAction,
        { courseId: course.id, name: 'GLOBAL' },
        { organizationId: otherOrg, db: testDb.db }
      )
    ).rejects.toBeInstanceOf(ActionRefusedError)
  })

  it('rejects an unknown key (z.strictObject)', async () => {
    testDb = createTestDatabase()
    const { organizationId, course } = seedOrganizationWithCourse(testDb.db)

    await expect(
      dispatch(
        addCourseCategoryAction,
        { courseId: course.id, name: 'GLOBAL', extra: 'nope' },
        { organizationId, db: testDb.db }
      )
    ).rejects.toBeInstanceOf(ActionInputError)
  })
})

describe('courseChannels.renameCategory', () => {
  it('renames the one category, leaving its sibling untouched', async () => {
    testDb = createTestDatabase()
    const { organizationId, categoryA, categoryB } =
      seedCourseWithTwoCategories(testDb.db)

    const result = await dispatch(
      renameCourseCategoryAction,
      { categoryId: categoryA.id, name: 'GLOBAL RENAMED' },
      { organizationId, db: testDb.db }
    )

    expect(result.name).toBe('GLOBAL RENAMED')
    const sibling = courses.getCourseCategory(
      organizationId,
      categoryB.id,
      testDb.db
    )
    expect(sibling?.category.name).toBe(categoryB.name)
  })

  it('refuses a categoryId belonging to another organization (ACT-3)', async () => {
    testDb = createTestDatabase()
    const { categoryA } = seedCourseWithTwoCategories(testDb.db)
    const otherOrg = seedOrganization(testDb.db, 'Other Org')

    await expect(
      dispatch(
        renameCourseCategoryAction,
        { categoryId: categoryA.id, name: 'X' },
        { organizationId: otherOrg, db: testDb.db }
      )
    ).rejects.toBeInstanceOf(ActionRefusedError)
  })
})

describe('courseChannels.removeCategory', () => {
  it('removes the category and its channels, reporting how many channels went with it, leaving the sibling category untouched', async () => {
    testDb = createTestDatabase()
    const { organizationId, categoryA, categoryB } =
      seedCourseWithTwoCategories(testDb.db)

    const result = await dispatch(
      removeCourseCategoryAction,
      { categoryId: categoryA.id },
      { organizationId, db: testDb.db }
    )

    expect(result).toEqual({ removed: true, removedChannelCount: 1 })
    expect(
      courses.getCourseCategory(organizationId, categoryA.id, testDb.db)
    ).toBeUndefined()
    expect(
      courses.getCourseCategory(organizationId, categoryB.id, testDb.db)
        ?.category.name
    ).toBe(categoryB.name)
  })

  it('refuses a categoryId belonging to another organization (ACT-3)', async () => {
    testDb = createTestDatabase()
    const { categoryA } = seedCourseWithTwoCategories(testDb.db)
    const otherOrg = seedOrganization(testDb.db, 'Other Org')

    await expect(
      dispatch(
        removeCourseCategoryAction,
        { categoryId: categoryA.id },
        { organizationId: otherOrg, db: testDb.db }
      )
    ).rejects.toBeInstanceOf(ActionRefusedError)
  })
})

describe('courseChannels.addChannel', () => {
  it('appends a channel to the category, leaving its sibling category untouched', async () => {
    testDb = createTestDatabase()
    const { organizationId, categoryA, categoryB } =
      seedCourseWithTwoCategories(testDb.db)

    const result = await dispatch(
      addCourseChannelAction,
      { categoryId: categoryA.id, name: 'questions', adminsOnly: false },
      { organizationId, db: testDb.db }
    )

    expect(result).toMatchObject({ name: 'questions', ordering: 1 })
    expect(
      courses.getCourseCategory(organizationId, categoryB.id, testDb.db)
        ?.category.channels
    ).toEqual([])
  })

  it('refuses a categoryId belonging to another organization (ACT-3)', async () => {
    testDb = createTestDatabase()
    const { categoryA } = seedCourseWithTwoCategories(testDb.db)
    const otherOrg = seedOrganization(testDb.db, 'Other Org')

    await expect(
      dispatch(
        addCourseChannelAction,
        { categoryId: categoryA.id, name: 'x', adminsOnly: false },
        { organizationId: otherOrg, db: testDb.db }
      )
    ).rejects.toBeInstanceOf(ActionRefusedError)
  })
})

describe('courseChannels.updateChannel', () => {
  it('with only adminsOnly leaves the name alone', async () => {
    testDb = createTestDatabase()
    const { organizationId, categoryA } = seedCourseWithTwoCategories(testDb.db)
    const channel = categoryA.channels[0]!
    expect(channel.adminsOnly).toBe(true)

    const result = await dispatch(
      updateCourseChannelAction,
      { channelId: channel.id, adminsOnly: false },
      { organizationId, db: testDb.db }
    )

    expect(result).toMatchObject({ name: channel.name, adminsOnly: false })
  })

  it('with only name leaves adminsOnly alone', async () => {
    testDb = createTestDatabase()
    const { organizationId, categoryA } = seedCourseWithTwoCategories(testDb.db)
    const channel = categoryA.channels[0]!

    const result = await dispatch(
      updateCourseChannelAction,
      { channelId: channel.id, name: 'renamed' },
      { organizationId, db: testDb.db }
    )

    expect(result).toMatchObject({
      name: 'renamed',
      adminsOnly: channel.adminsOnly,
    })
  })

  it('refuses an explicit null for name or adminsOnly — neither field is nullable', async () => {
    testDb = createTestDatabase()
    const { organizationId, categoryA } = seedCourseWithTwoCategories(testDb.db)
    const channel = categoryA.channels[0]!

    await expect(
      dispatch(
        updateCourseChannelAction,
        { channelId: channel.id, name: null },
        { organizationId, db: testDb.db }
      )
    ).rejects.toBeInstanceOf(ActionInputError)
  })

  it('refuses a channelId belonging to another organization (ACT-3)', async () => {
    testDb = createTestDatabase()
    const { categoryA } = seedCourseWithTwoCategories(testDb.db)
    const otherOrg = seedOrganization(testDb.db, 'Other Org')

    await expect(
      dispatch(
        updateCourseChannelAction,
        { channelId: categoryA.channels[0]!.id, name: 'x' },
        { organizationId: otherOrg, db: testDb.db }
      )
    ).rejects.toBeInstanceOf(ActionRefusedError)
  })
})

describe('courseChannels.removeChannel', () => {
  it('removes only the one channel, leaving its sibling category untouched', async () => {
    testDb = createTestDatabase()
    const { organizationId, categoryA, categoryB } =
      seedCourseWithTwoCategories(testDb.db)
    const channel = categoryA.channels[0]!

    const result = await dispatch(
      removeCourseChannelAction,
      { channelId: channel.id },
      { organizationId, db: testDb.db }
    )

    expect(result).toEqual({ removed: true })
    expect(
      courses.getCourseCategory(organizationId, categoryA.id, testDb.db)
        ?.category.channels
    ).toEqual([])
    expect(
      courses.getCourseCategory(organizationId, categoryB.id, testDb.db)
        ?.category.name
    ).toBe(categoryB.name)
  })

  it('refuses a channelId belonging to another organization (ACT-3)', async () => {
    testDb = createTestDatabase()
    const { categoryA } = seedCourseWithTwoCategories(testDb.db)
    const otherOrg = seedOrganization(testDb.db, 'Other Org')

    await expect(
      dispatch(
        removeCourseChannelAction,
        { channelId: categoryA.channels[0]!.id },
        { organizationId: otherOrg, db: testDb.db }
      )
    ).rejects.toBeInstanceOf(ActionRefusedError)
  })
})
