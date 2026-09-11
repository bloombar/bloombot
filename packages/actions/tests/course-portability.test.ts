/**
 * PORT-1..PORT-8: `courses.export` and `courses.import` as a round trip — a
 * course exported and imported back produces the course it came from, minus
 * exactly the things PORT-3 says cannot travel, with a title that does not
 * collide (PORT-5) and routing switched off until somebody says otherwise
 * (PORT-6).
 */

import {
  accounts,
  conversations,
  courseInstructionRevisions,
  courseAttachments,
  courses,
  courseWebSources,
  enrolments,
  people,
} from '@bloombot/db'
import { parse as parseYaml } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'

import {
  exportCourseAction,
  importCourseAction,
  courseExportFilename,
} from '../src/actions/index.js'
import { dispatch } from '../src/dispatch.js'
import {
  ActionConflictError,
  ActionInputError,
  ActionRefusedError,
} from '../src/errors.js'
import {
  seedOrganization,
  seedOrganizationWithProject,
} from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

/**
 * A fresh account in `organizationId` to attribute a dispatch to — FILE-4
 * requires an author for the instructions revision an import records, so
 * every dispatch below carries one.
 */
function accountId(organizationId: string): string {
  return accounts.createAccount(
    organizationId,
    {
      email: `${organizationId}-${accountCounter++}@example.edu`,
      displayName: 'Importer',
      role: 'owner',
    },
    testDb.db
  ).id
}

let accountCounter = 0

afterEach(() => {
  testDb.cleanup()
})

/** The course these tests export: every field the format carries, set to something distinguishable. */
function seedFullCourse(
  organizationId: string,
  projectId: string,
  db: TestDatabase['db'],
  overrides: Partial<Parameters<typeof courses.createCourse>[1]> = {}
) {
  const result = courses.createCourse(
    organizationId,
    {
      projectId,
      title: 'Intro to CS',
      enabled: true,
      adminsRole: 'admins-cs-fa26',
      studentsRole: 'students-cs-fa26',
      instructions: 'Answer in plain language.',
      model: 'gpt-5',
      maxRequestsPerDay: 40,
      conversationScope: 'course_surface',
      // ENRL-13/ENRL-14 — non-default values, so a round trip that
      // silently reverted either to its default would show up as a
      // mismatch here rather than passing by accident.
      selfEnrolFromDiscord: true,
      answerUnenrolled: false,
      categories: [
        {
          name: 'Intro to CS - GLOBAL',
          channels: [
            { name: 'announcements', adminsOnly: true },
            { name: 'chat', adminsOnly: false },
          ],
        },
        { name: 'Intro to CS - STUDENTS', channels: [] },
      ],
      ...overrides,
    },
    db
  )
  if (!result.ok) throw new Error('setup failed: unexpected conflict')
  return result.course
}

/** Exports `courseId` and hands back the YAML text, the way the panel would then download it. */
async function exportText(
  organizationId: string,
  courseId: string,
  db: TestDatabase['db']
): Promise<string> {
  const result = await dispatch(
    exportCourseAction,
    { courseId },
    { organizationId, db }
  )
  return result.content
}

describe('courses.export', () => {
  it("writes the course's settings, categories, channels and websites", async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const course = seedFullCourse(organizationId, projectId, testDb.db)
    courseWebSources.addWebSource(
      organizationId,
      { courseId: course.id, domain: 'example.edu' },
      testDb.db
    )

    const result = await dispatch(
      exportCourseAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: accountId(organizationId) }
    )

    expect(result.filename).toBe('intro-to-cs.course.yml')
    const file = parseYaml(result.content) as Record<string, unknown>
    expect(file['bloombotCourseExport']).toBe(1)
    expect(file['kind']).toBe('bloombot.course')
    expect(file['course']).toMatchObject({
      title: 'Intro to CS',
      adminsRole: 'admins-cs-fa26',
      studentsRole: 'students-cs-fa26',
      model: 'gpt-5',
      instructions: 'Answer in plain language.',
      maxRequestsPerDay: 40,
      conversationScope: 'course_surface',
      selfEnrolFromDiscord: true,
      answerUnenrolled: false,
      websites: ['example.edu'],
      categories: [
        {
          name: 'Intro to CS - GLOBAL',
          channels: [
            { name: 'announcements', adminsOnly: true },
            { name: 'chat', adminsOnly: false },
          ],
        },
        { name: 'Intro to CS - STUDENTS', channels: [] },
      ],
    })
  })

  it('carries nothing about a person (PORT-2)', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const course = seedFullCourse(organizationId, projectId, testDb.db)
    // A course with a real student on it, a conversation and an enrolment —
    // none of which the file may mention.
    const person = people.createPerson(
      organizationId,
      {
        displayName: 'Ada Lovelace',
        email: 'ada@example.edu',
        firstName: 'Ada',
        lastName: 'Lovelace',
      },
      testDb.db
    )
    enrolments.enrolViaRoster(
      organizationId,
      { courseId: course.id, personId: person.id },
      testDb.db
    )
    conversations.getOrCreateConversation(
      organizationId,
      { courseId: course.id, personId: person.id, surface: 'web' },
      testDb.db
    )

    const text = await exportText(organizationId, course.id, testDb.db)

    expect(text).not.toContain('Ada')
    expect(text).not.toContain('ada@example.edu')
    expect(text).not.toContain(person.id)
    expect(text).not.toContain(organizationId)
    expect(text).not.toContain(course.id)
  })

  it('names what it could not carry, without the identifiers (PORT-3)', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const course = seedFullCourse(organizationId, projectId, testDb.db, {
      promptId: 'prompt-abc',
      vectorStoreId: 'vs-abc',
    })
    courseAttachments.createPendingAttachment(
      organizationId,
      {
        courseId: course.id,
        filename: 'syllabus.pdf',
        contentType: 'application/pdf',
        sizeBytes: 10,
      },
      testDb.db
    )

    const result = await dispatch(
      exportCourseAction,
      { courseId: course.id },
      { organizationId, db: testDb.db, accountId: accountId(organizationId) }
    )

    expect(result.notCarried).toEqual({
      vectorStore: true,
      storedPrompt: true,
      attachments: 1,
      discordServer: false,
    })
    expect(result.content).not.toContain('vs-abc')
    expect(result.content).not.toContain('prompt-abc')
  })

  it('refuses a course in another organization the same way every read does', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const course = seedFullCourse(organizationId, projectId, testDb.db)
    const otherOrganizationId = seedOrganization(testDb.db, 'Other Org')

    await expect(
      dispatch(
        exportCourseAction,
        { courseId: course.id },
        {
          organizationId: otherOrganizationId,
          db: testDb.db,
          accountId: accountId(otherOrganizationId),
        }
      )
    ).rejects.toBeInstanceOf(ActionRefusedError)
  })
})

describe('courses.import', () => {
  it('round-trips a course into another organization (PORT-4)', async () => {
    testDb = createTestDatabase()
    const source = seedOrganizationWithProject(testDb.db, 'Fall 2026')
    const course = seedFullCourse(
      source.organizationId,
      source.projectId,
      testDb.db
    )
    courseWebSources.addWebSource(
      source.organizationId,
      { courseId: course.id, domain: 'example.edu' },
      testDb.db
    )
    const text = await exportText(source.organizationId, course.id, testDb.db)

    const destination = seedOrganizationWithProject(testDb.db, 'Spring 2027')
    const result = await dispatch(
      importCourseAction,
      { projectId: destination.projectId, content: text },
      {
        organizationId: destination.organizationId,
        db: testDb.db,
        accountId: accountId(destination.organizationId),
      }
    )

    expect(result.title).toBe('Intro to CS')
    expect(result.titleChanged).toBe(false)
    expect(result.disabled).toBe(true)
    expect(result.course).toMatchObject({
      organizationId: destination.organizationId,
      projectId: destination.projectId,
      title: 'Intro to CS',
      enabled: false,
      adminsRole: 'admins-cs-fa26',
      studentsRole: 'students-cs-fa26',
      instructions: 'Answer in plain language.',
      model: 'gpt-5',
      maxRequestsPerDay: 40,
      conversationScope: 'course_surface',
      // must-fix 4, review round 1 — both reviewers found this
      // independently: neither setting was on the field list `courses.import`
      // otherwise carries faithfully, so a round trip silently reversed an
      // access decision with no report at all.
      selfEnrolFromDiscord: true,
      answerUnenrolled: false,
    })
    expect(result.course.categories.map((category) => category.name)).toEqual([
      'Intro to CS - GLOBAL',
      'Intro to CS - STUDENTS',
    ])
    expect(
      result.course.categories[0]?.channels.map((channel) => ({
        name: channel.name,
        adminsOnly: channel.adminsOnly,
      }))
    ).toEqual([
      { name: 'announcements', adminsOnly: true },
      { name: 'chat', adminsOnly: false },
    ])
    expect(
      courseWebSources
        .listWebSourcesForCourse(
          destination.organizationId,
          result.course.id,
          testDb.db
        )
        .map((source_) => source_.domain)
    ).toEqual(['example.edu'])
    // PORT-3 — the three provider- and organization-bound settings arrive
    // unset rather than pointing at something this organization cannot reach.
    expect(result.course.vectorStoreId).toBeNull()
    expect(result.course.promptId).toBeNull()
    expect(result.course.discordServerId).toBeNull()
    expect(result.course.id).not.toBe(course.id)
  })

  // PROJ-7: a course naming no role at all round-trips cleanly — the
  // exported file carries `null` for both (`exportedCourseSchema`'s own
  // nullable, not a version bump — that schema's own comment), and the
  // import writes `null` back, not an empty string or a name it invented.
  it('a course with no roles round-trips through export and import', async () => {
    testDb = createTestDatabase()
    const source = seedOrganizationWithProject(testDb.db, 'Fall 2026')
    const course = seedFullCourse(
      source.organizationId,
      source.projectId,
      testDb.db,
      {
        adminsRole: null,
        studentsRole: null,
      }
    )
    const text = await exportText(source.organizationId, course.id, testDb.db)
    expect(parseYaml(text)).toMatchObject({
      course: { adminsRole: null, studentsRole: null },
    })

    const destination = seedOrganizationWithProject(testDb.db, 'Spring 2027')
    const result = await dispatch(
      importCourseAction,
      { projectId: destination.projectId, content: text },
      {
        organizationId: destination.organizationId,
        db: testDb.db,
        accountId: accountId(destination.organizationId),
      }
    )

    expect(result.course.adminsRole).toBeNull()
    expect(result.course.studentsRole).toBeNull()
  })

  // The other half: an export written before PROJ-7 existed always named
  // both roles (`exportedCourseSchema`'s own `.nullable()`, not new keys —
  // an older file's non-null string still parses exactly as it always did),
  // so it must still import with those names intact.
  it('an older export naming both roles still imports with those names intact', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const oldFile = [
      'bloombotCourseExport: 1',
      'kind: bloombot.course',
      "exportedAt: '2026-01-01T00:00:00.000Z'",
      'course:',
      '  title: Intro to CS',
      '  adminsRole: admins-cs-fa26',
      '  studentsRole: students-cs-fa26',
      '  model: null',
      '  instructions: null',
      '  maxRequestsPerDay: null',
      '  conversationScope: course',
      '  categories: []',
      '  websites: []',
      'notCarried:',
      '  vectorStore: false',
      '  storedPrompt: false',
      '  attachments: 0',
      '  discordServer: false',
      '',
    ].join('\n')

    const result = await dispatch(
      importCourseAction,
      { projectId, content: oldFile },
      { organizationId, db: testDb.db, accountId: accountId(organizationId) }
    )

    expect(result.course.adminsRole).toBe('admins-cs-fa26')
    expect(result.course.studentsRole).toBe('students-cs-fa26')
  })

  it('numbers a title already used in the destination project (PORT-5)', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const course = seedFullCourse(organizationId, projectId, testDb.db)
    const text = await exportText(organizationId, course.id, testDb.db)

    const first = await dispatch(
      importCourseAction,
      { projectId, content: text },
      { organizationId, db: testDb.db, accountId: accountId(organizationId) }
    )
    expect(first.title).toBe('Intro to CS 2')
    expect(first.titleChanged).toBe(true)

    const second = await dispatch(
      importCourseAction,
      { projectId, content: text },
      { organizationId, db: testDb.db, accountId: accountId(organizationId) }
    )
    expect(second.title).toBe('Intro to CS 3')
  })

  it('arrives disabled even when the file came from an enabled course (PORT-6)', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const course = seedFullCourse(organizationId, projectId, testDb.db)
    expect(course.enabled).toBe(true)
    const text = await exportText(organizationId, course.id, testDb.db)

    const result = await dispatch(
      importCourseAction,
      { projectId, content: text },
      { organizationId, db: testDb.db, accountId: accountId(organizationId) }
    )

    // The copy carries the original's role and category names — exactly the
    // PROJ-3 collision — so it must not be enabled, and is not.
    expect(result.course.enabled).toBe(false)
    expect(result.course.adminsRole).toBe(course.adminsRole)
  })

  it('reports what the file could not carry (PORT-7)', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const course = seedFullCourse(organizationId, projectId, testDb.db, {
      vectorStoreId: 'vs-abc',
    })
    const text = await exportText(organizationId, course.id, testDb.db)

    const result = await dispatch(
      importCourseAction,
      { projectId, content: text },
      { organizationId, db: testDb.db, accountId: accountId(organizationId) }
    )

    expect(result.notCarried).toMatchObject({
      vectorStore: true,
      attachments: 0,
    })
  })

  // must-fix 4, review round 1 — a file exported before ENRL-13/ENRL-14
  // existed carries neither key at all (`exportedCourseSchema`'s own
  // `.optional()` on both, `@bloombot/schemas`); this pins that an absent
  // value means "the behaviour this course had before either setting
  // existed," the same defaults `schema.ts`'s own database columns carry —
  // not that the file is refused, and not `undefined` reaching
  // `createCourse` as something other than its own default.
  it("imports an older file with neither ENRL-13 nor ENRL-14 key at all, defaulting to today's behaviour", async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const oldFile = [
      'bloombotCourseExport: 1',
      'kind: bloombot.course',
      "exportedAt: '2026-01-01T00:00:00.000Z'",
      'course:',
      '  title: Intro to CS',
      '  adminsRole: admins-cs-fa26',
      '  studentsRole: students-cs-fa26',
      '  model: null',
      '  instructions: null',
      '  maxRequestsPerDay: null',
      '  conversationScope: course',
      '  categories: []',
      '  websites: []',
      'notCarried:',
      '  vectorStore: false',
      '  storedPrompt: false',
      '  attachments: 0',
      '  discordServer: false',
      '',
    ].join('\n')

    const result = await dispatch(
      importCourseAction,
      { projectId, content: oldFile },
      { organizationId, db: testDb.db, accountId: accountId(organizationId) }
    )

    expect(result.course).toMatchObject({
      title: 'Intro to CS',
      selfEnrolFromDiscord: false,
      answerUnenrolled: true,
    })
  })

  it('refuses a file that is not YAML, before writing anything', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)

    await expect(
      dispatch(
        importCourseAction,
        { projectId, content: '{ this is: not: yaml: at all' },
        { organizationId, db: testDb.db, accountId: accountId(organizationId) }
      )
    ).rejects.toBeInstanceOf(ActionInputError)
    expect(
      courses.listCourses(organizationId, testDb.db, { projectId })
    ).toEqual([])
  })

  it('refuses a file from a version it does not read, saying so', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)

    const caught = await dispatch(
      importCourseAction,
      {
        projectId,
        content: 'bloombotCourseExport: 99\nkind: bloombot.course\n',
      },
      { organizationId, db: testDb.db, accountId: accountId(organizationId) }
    ).catch((error: unknown) => error)

    expect(caught).toBeInstanceOf(ActionInputError)
    expect((caught as ActionInputError).issues[0]?.message).toContain(
      'version 99'
    )
    expect(
      courses.listCourses(organizationId, testDb.db, { projectId })
    ).toEqual([])
  })

  it('refuses a hand-edited file whose two roles are the same', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const course = seedFullCourse(organizationId, projectId, testDb.db)
    const text = (
      await exportText(organizationId, course.id, testDb.db)
    ).replace('students-cs-fa26', 'admins-cs-fa26')

    await expect(
      dispatch(
        importCourseAction,
        { projectId, content: text },
        { organizationId, db: testDb.db, accountId: accountId(organizationId) }
      )
    ).rejects.toBeInstanceOf(ActionConflictError)
  })

  it('records the imported instructions as an authored revision (FILE-4)', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const course = seedFullCourse(organizationId, projectId, testDb.db)
    const text = await exportText(organizationId, course.id, testDb.db)
    const importer = accountId(organizationId)

    const result = await dispatch(
      importCourseAction,
      { projectId, content: text },
      { organizationId, db: testDb.db, accountId: importer }
    )

    // Without this, the panel's instructions history is empty for a course
    // whose instructions plainly exist — the live column set, nothing behind
    // it.
    const revisions = courseInstructionRevisions.listRevisionsForCourse(
      organizationId,
      result.course.id,
      testDb.db
    )
    expect(revisions).toHaveLength(1)
    expect(revisions[0]).toMatchObject({
      instructions: 'Answer in plain language.',
      savedByAccountId: importer,
    })
  })

  it('refuses an import with no account to attribute it to', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const course = seedFullCourse(organizationId, projectId, testDb.db)
    const text = await exportText(organizationId, course.id, testDb.db)

    await expect(
      dispatch(
        importCourseAction,
        { projectId, content: text },
        { organizationId, db: testDb.db }
      )
    ).rejects.toBeInstanceOf(ActionRefusedError)
  })

  it('refuses a project in another organization (TEN-2)', async () => {
    testDb = createTestDatabase()
    const { organizationId, projectId } = seedOrganizationWithProject(testDb.db)
    const course = seedFullCourse(organizationId, projectId, testDb.db)
    const text = await exportText(organizationId, course.id, testDb.db)
    const otherOrganizationId = seedOrganization(testDb.db, 'Other Org')

    await expect(
      dispatch(
        importCourseAction,
        { projectId, content: text },
        {
          organizationId: otherOrganizationId,
          db: testDb.db,
          accountId: accountId(otherOrganizationId),
        }
      )
    ).rejects.toBeInstanceOf(ActionRefusedError)
  })
})

describe('courseExportFilename', () => {
  it('reduces a title to something a filesystem accepts', () => {
    expect(courseExportFilename('Intro to CS 2')).toBe(
      'intro-to-cs-2.course.yml'
    )
    expect(courseExportFilename('Web Design & Dev!')).toBe(
      'web-design-dev.course.yml'
    )
  })

  it('falls back rather than producing a bare extension', () => {
    expect(courseExportFilename('!!!')).toBe('course.course.yml')
  })
})
