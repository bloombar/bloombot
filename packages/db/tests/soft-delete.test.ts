/**
 * DATA-7/DATA-9 — the tombstone, the cascade, and the read filter, exercised
 * end to end for all six deletable entity kinds: an account, a person, an
 * organization, a project, a course, and one person's conversation history
 * in a course. Synthetic data only (QA-3).
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  accounts,
  conversations,
  courses,
  organizations,
  people,
  projects,
} from '@bloombot/db'

import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** One organization, one project, one course, one person and one platform-administrator-style account to delete things with — the smallest graph every test below needs. */
function seedGraph(testDatabase: TestDatabase) {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Test Org', isPersonal: false },
    testDatabase.db
  )
  const project = projects.createProject(
    organizationId,
    { name: 'Fall 2026' },
    testDatabase.db
  )
  const courseResult = courses.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: 'Web Design',
      enabled: true,
      adminsRole: 'admins-wd',
      studentsRole: 'students-wd',
      categories: [],
    },
    testDatabase.db
  )
  if (!courseResult.ok) throw new Error('seed course creation failed')
  const person = people.createPerson(
    organizationId,
    { displayName: 'Alice' },
    testDatabase.db
  )
  const deleter = accounts.createAccount(
    organizationId,
    {
      email: `deleter-${randomUUID()}@example.edu`,
      displayName: 'Deleter',
      role: 'owner',
    },
    testDatabase.db
  )

  return {
    organizationId,
    project,
    course: courseResult.course,
    person,
    deleter,
  }
}

describe('DATA-7 — soft-deleting and restoring an account', () => {
  it('hides the account from every read, and restore brings it back', () => {
    testDb = createTestDatabase()
    const { organizationId, deleter } = seedGraph(testDb)
    const account = accounts.createAccount(
      organizationId,
      {
        email: `student-${randomUUID()}@example.edu`,
        displayName: 'Student',
        role: 'owner',
      },
      testDb.db
    )

    expect(accounts.getAccountById(account.id, testDb.db)).toBeDefined()

    const deleted = accounts.softDeleteAccount(
      account.id,
      deleter.id,
      testDb.db
    )
    expect(deleted).toMatchObject({
      id: account.id,
      deletedByAccountId: deleter.id,
    })
    expect(typeof deleted?.deletedAt).toBe('number')

    expect(accounts.getAccountById(account.id, testDb.db)).toBeUndefined()
    expect(accounts.getAccountByEmail(account.email, testDb.db)).toBeUndefined()

    const restored = accounts.restoreAccount(account.id, testDb.db)
    expect(restored).toMatchObject({
      id: account.id,
      deletedAt: null,
      deletedByAccountId: null,
    })
    expect(accounts.getAccountById(account.id, testDb.db)).toBeDefined()
  })

  it('refuses to soft-delete an account twice, and refuses to restore one that was never deleted', () => {
    testDb = createTestDatabase()
    const { organizationId, deleter } = seedGraph(testDb)
    const account = accounts.createAccount(
      organizationId,
      {
        email: `once-${randomUUID()}@example.edu`,
        displayName: 'Once',
        role: 'owner',
      },
      testDb.db
    )

    expect(
      accounts.softDeleteAccount(account.id, deleter.id, testDb.db)
    ).toBeDefined()
    expect(
      accounts.softDeleteAccount(account.id, deleter.id, testDb.db)
    ).toBeUndefined()
    expect(accounts.restoreAccount(account.id, testDb.db)).toBeDefined()
    expect(accounts.restoreAccount(account.id, testDb.db)).toBeUndefined()
  })
})

describe('DATA-7 — soft-deleting and restoring a person', () => {
  it('hides the person from every read and cascades to their conversations, restore brings both back', () => {
    testDb = createTestDatabase()
    const { organizationId, course, person, deleter } = seedGraph(testDb)
    const conversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId: course.id, personId: person.id, surface: 'discord' },
      testDb.db
    )
    if (!conversation) throw new Error('seed conversation creation failed')

    const deleted = people.softDeletePerson(
      organizationId,
      person.id,
      deleter.id,
      testDb.db
    )
    expect(deleted).toMatchObject({
      id: person.id,
      deletedByAccountId: deleter.id,
    })

    expect(
      people.getPerson(organizationId, person.id, testDb.db)
    ).toBeUndefined()
    expect(people.listPeople(organizationId, testDb.db)).toHaveLength(0)
    expect(
      conversations.getConversation(organizationId, conversation.id, testDb.db)
    ).toBeUndefined()

    const restored = people.restorePerson(organizationId, person.id, testDb.db)
    expect(restored).toMatchObject({ id: person.id, deletedAt: null })
    expect(people.getPerson(organizationId, person.id, testDb.db)).toBeDefined()
    expect(
      conversations.getConversation(organizationId, conversation.id, testDb.db)
    ).toBeDefined()
  })

  it('a conversation deleted on its own, before the person, stays deleted when the person is restored', () => {
    testDb = createTestDatabase()
    const { organizationId, course, person, deleter } = seedGraph(testDb)
    const conversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId: course.id, personId: person.id, surface: 'discord' },
      testDb.db
    )
    if (!conversation) throw new Error('seed conversation creation failed')

    // `vi`'s fake clock, not a real one — two soft-deletes issued back to
    // back in the same test can otherwise land in the same millisecond,
    // which would give the conversation and the person's own cascade the
    // *same* `deletedAt` by accident and make this test flaky rather than a
    // real check of DATA-7's "something deleted earlier, on purpose, stays
    // deleted".
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    // Deleted independently, earlier — its own, older timestamp.
    conversations.softDeleteConversationsForPerson(
      organizationId,
      course.id,
      person.id,
      deleter.id,
      testDb.db
    )
    expect(
      conversations.getConversation(organizationId, conversation.id, testDb.db)
    ).toBeUndefined()

    // The person is deleted afterward, stamping every *still-live* row with
    // a new, later timestamp — this conversation is not one of them, since
    // it is already deleted.
    vi.setSystemTime(2_000_000)
    people.softDeletePerson(organizationId, person.id, deleter.id, testDb.db)
    vi.useRealTimers()
    const restoredPerson = people.restorePerson(
      organizationId,
      person.id,
      testDb.db
    )
    expect(restoredPerson).toBeDefined()

    // DATA-7's own point: something deleted earlier, on purpose, stays
    // deleted — the person's own restore only un-marks children it marked.
    expect(
      conversations.getConversation(organizationId, conversation.id, testDb.db)
    ).toBeUndefined()
  })
})

describe('DATA-7 — soft-deleting and restoring an organization', () => {
  it('hides the organization and cascades to its projects, courses, people and conversations; restore brings all of it back', () => {
    testDb = createTestDatabase()
    const { organizationId, project, course, person, deleter } =
      seedGraph(testDb)
    const conversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId: course.id, personId: person.id, surface: 'discord' },
      testDb.db
    )
    if (!conversation) throw new Error('seed conversation creation failed')

    const deleted = organizations.softDeleteOrganization(
      organizationId,
      deleter.id,
      testDb.db
    )
    expect(deleted).toMatchObject({
      id: organizationId,
      deletedByAccountId: deleter.id,
    })

    expect(
      organizations.getOrganizationById(organizationId, testDb.db)
    ).toBeUndefined()
    expect(
      projects.getProject(organizationId, project.id, testDb.db)
    ).toBeUndefined()
    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeUndefined()
    expect(
      people.getPerson(organizationId, person.id, testDb.db)
    ).toBeUndefined()
    expect(
      conversations.getConversation(organizationId, conversation.id, testDb.db)
    ).toBeUndefined()

    const restored = organizations.restoreOrganization(
      organizationId,
      testDb.db
    )
    expect(restored).toMatchObject({ id: organizationId, deletedAt: null })

    expect(
      organizations.getOrganizationById(organizationId, testDb.db)
    ).toBeDefined()
    expect(
      projects.getProject(organizationId, project.id, testDb.db)
    ).toBeDefined()
    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeDefined()
    expect(people.getPerson(organizationId, person.id, testDb.db)).toBeDefined()
    expect(
      conversations.getConversation(organizationId, conversation.id, testDb.db)
    ).toBeDefined()
  })

  it('a course deleted on its own, before the organization, stays deleted when the organization is restored', () => {
    testDb = createTestDatabase()
    const { organizationId, course, deleter } = seedGraph(testDb)

    // See the identical "before the person" test above for why a fake clock
    // is what makes this timestamp ordering deterministic rather than flaky.
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    courses.softDeleteCourse(organizationId, course.id, deleter.id, testDb.db)
    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeUndefined()

    vi.setSystemTime(2_000_000)
    organizations.softDeleteOrganization(organizationId, deleter.id, testDb.db)
    vi.useRealTimers()
    organizations.restoreOrganization(organizationId, testDb.db)

    expect(
      organizations.getOrganizationById(organizationId, testDb.db)
    ).toBeDefined()
    // The course was deleted earlier, on purpose — the organization's own
    // restore only un-marks children it marked with its own timestamp.
    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeUndefined()
  })
})

describe('DATA-7 — soft-deleting and restoring a project', () => {
  it('hides the project and cascades to its courses and their conversations; restore brings both back', () => {
    testDb = createTestDatabase()
    const { organizationId, project, course, person, deleter } =
      seedGraph(testDb)
    const conversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId: course.id, personId: person.id, surface: 'discord' },
      testDb.db
    )
    if (!conversation) throw new Error('seed conversation creation failed')

    const deleted = projects.softDeleteProject(
      organizationId,
      project.id,
      deleter.id,
      testDb.db
    )
    expect(deleted).toMatchObject({
      id: project.id,
      deletedByAccountId: deleter.id,
    })

    expect(
      projects.getProject(organizationId, project.id, testDb.db)
    ).toBeUndefined()
    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeUndefined()
    expect(
      conversations.getConversation(organizationId, conversation.id, testDb.db)
    ).toBeUndefined()

    const restored = projects.restoreProject(
      organizationId,
      project.id,
      testDb.db
    )
    expect(restored).toMatchObject({ id: project.id, deletedAt: null })

    expect(
      projects.getProject(organizationId, project.id, testDb.db)
    ).toBeDefined()
    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeDefined()
    expect(
      conversations.getConversation(organizationId, conversation.id, testDb.db)
    ).toBeDefined()
  })

  it('a course deleted on its own, before the project, stays deleted when the project is restored', () => {
    testDb = createTestDatabase()
    const { organizationId, project, course, deleter } = seedGraph(testDb)

    // See "before the person" above for why a fake clock is what makes this
    // timestamp ordering deterministic rather than flaky.
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    courses.softDeleteCourse(organizationId, course.id, deleter.id, testDb.db)
    vi.setSystemTime(2_000_000)
    projects.softDeleteProject(
      organizationId,
      project.id,
      deleter.id,
      testDb.db
    )
    vi.useRealTimers()
    projects.restoreProject(organizationId, project.id, testDb.db)

    expect(
      projects.getProject(organizationId, project.id, testDb.db)
    ).toBeDefined()
    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeUndefined()
  })
})

describe('DATA-7 — soft-deleting and restoring a course', () => {
  it('hides the course and cascades to its conversations; restore brings both back', () => {
    testDb = createTestDatabase()
    const { organizationId, course, person, deleter } = seedGraph(testDb)
    const conversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId: course.id, personId: person.id, surface: 'discord' },
      testDb.db
    )
    if (!conversation) throw new Error('seed conversation creation failed')

    const deleted = courses.softDeleteCourse(
      organizationId,
      course.id,
      deleter.id,
      testDb.db
    )
    expect(deleted).toMatchObject({
      id: course.id,
      deletedByAccountId: deleter.id,
    })

    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeUndefined()
    expect(courses.listCourses(organizationId, testDb.db)).toHaveLength(0)
    expect(
      conversations.getConversation(organizationId, conversation.id, testDb.db)
    ).toBeUndefined()
    expect(
      conversations.listConversationsForCourse(
        organizationId,
        course.id,
        testDb.db
      )
    ).toHaveLength(0)

    const restored = courses.restoreCourse(organizationId, course.id, testDb.db)
    expect(restored).toMatchObject({ id: course.id, deletedAt: null })

    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeDefined()
    expect(
      conversations.getConversation(organizationId, conversation.id, testDb.db)
    ).toBeDefined()
  })

  it('a conversation deleted on its own, before the course, stays deleted when the course is restored', () => {
    testDb = createTestDatabase()
    const { organizationId, course, person, deleter } = seedGraph(testDb)
    const conversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId: course.id, personId: person.id, surface: 'discord' },
      testDb.db
    )
    if (!conversation) throw new Error('seed conversation creation failed')

    // See "before the person" above for why a fake clock is what makes this
    // timestamp ordering deterministic rather than flaky.
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    conversations.softDeleteConversationsForPerson(
      organizationId,
      course.id,
      person.id,
      deleter.id,
      testDb.db
    )
    vi.setSystemTime(2_000_000)
    courses.softDeleteCourse(organizationId, course.id, deleter.id, testDb.db)
    vi.useRealTimers()
    courses.restoreCourse(organizationId, course.id, testDb.db)

    expect(
      courses.getCourse(organizationId, course.id, testDb.db)
    ).toBeDefined()
    expect(
      conversations.getConversation(organizationId, conversation.id, testDb.db)
    ).toBeUndefined()
  })
})

describe("DATA-7/WEB-73 — soft-deleting and restoring one person's own conversation history in a course", () => {
  it('hides the messages from the transcript and restore brings them back', () => {
    testDb = createTestDatabase()
    const { organizationId, course, person, deleter } = seedGraph(testDb)
    const conversation = conversations.getOrCreateConversation(
      organizationId,
      { courseId: course.id, personId: person.id, surface: 'discord' },
      testDb.db
    )
    if (!conversation) throw new Error('seed conversation creation failed')
    conversations.appendMessage(
      organizationId,
      conversation.id,
      { direction: 'from_person', content: 'hello' },
      testDb.db
    )

    const deleted = conversations.softDeleteConversationsForPerson(
      organizationId,
      course.id,
      person.id,
      deleter.id,
      testDb.db
    )
    expect(deleted).toHaveLength(1)
    expect(deleted[0]).toMatchObject({
      id: conversation.id,
      deletedByAccountId: deleter.id,
    })

    expect(
      conversations.getConversation(organizationId, conversation.id, testDb.db)
    ).toBeUndefined()
    // DATA-9 — `messages` carries no tombstone of its own; the transcript
    // read is what hides them, via the join through `conversations`.
    expect(
      conversations.getTranscript(organizationId, conversation.id, testDb.db)
    ).toHaveLength(0)

    const restored = conversations.restoreConversationsForPerson(
      organizationId,
      course.id,
      person.id,
      testDb.db
    )
    expect(restored).toHaveLength(1)
    expect(
      conversations.getConversation(organizationId, conversation.id, testDb.db)
    ).toBeDefined()
    expect(
      conversations.getTranscript(organizationId, conversation.id, testDb.db)
    ).toHaveLength(1)
  })

  it('offers nothing to delete for a person who has asked nothing in the course', () => {
    testDb = createTestDatabase()
    const { organizationId, course, person, deleter } = seedGraph(testDb)

    const deleted = conversations.softDeleteConversationsForPerson(
      organizationId,
      course.id,
      person.id,
      deleter.id,
      testDb.db
    )
    expect(deleted).toEqual([])
  })
})
