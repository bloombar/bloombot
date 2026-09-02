/**
 * Test helper: the smallest organization/project/course/person graph
 * `answer.ts` needs, synthetic data only (QA-3) — written through
 * `@bloombot/db`'s own repos, never raw SQL, the same convention
 * `packages/legacy-import`'s tests hold the importer to.
 */

import { randomUUID } from 'node:crypto'

import {
  courses,
  organizations,
  people,
  projects,
  type Database,
} from '@bloombot/db'

export interface SeedResult {
  organizationId: string
  courseId: string
  personId: string
}

export interface SeedOptions {
  maxRequestsPerDay?: number | null
  promptId?: string | null
  instructions?: string | null
  model?: string | null
  vectorStoreId?: string | null
  /** LINK-1 — connect the seeded person by default (see below); `false` for a test that specifically wants an unconnected person. */
  connect?: boolean
}

/** One organization, one project, one enabled course and one person — enough for `answerQuestion` to run against. */
export function seedCourseAndPerson(
  db: Database,
  options: SeedOptions = {}
): SeedResult {
  const organizationId = randomUUID()
  organizations.createOrganization(
    organizationId,
    { name: 'Test Org', isPersonal: false },
    db
  )

  const project = projects.createProject(
    organizationId,
    { name: 'Test Term' },
    db
  )

  const courseResult = courses.createCourse(
    organizationId,
    {
      projectId: project.id,
      title: 'Test Course',
      filePrefix: 'tc',
      enabled: true,
      adminsRole: 'admins-tc',
      studentsRole: 'students-tc',
      maxRequestsPerDay:
        options.maxRequestsPerDay === undefined
          ? 10
          : options.maxRequestsPerDay,
      promptId: options.promptId ?? null,
      // `?? 'Be helpful.'` can't tell "omitted" from "explicitly `null`"
      // (finding 3 of the CORE-1 rework needs a course with neither
      // `promptId` nor `instructions` set) — `undefined`-checked instead,
      // the same device `maxRequestsPerDay` above already uses.
      instructions:
        options.instructions === undefined
          ? 'Be helpful.'
          : options.instructions,
      model: options.model ?? null,
      vectorStoreId: options.vectorStoreId ?? null,
      categories: [{ name: 'Test Category', channels: [] }],
    },
    db
  )
  if (!courseResult.ok) {
    throw new Error(
      `seedCourseAndPerson: failed to create course: ${courseResult.conflict.message}`
    )
  }

  const person = people.createPerson(
    organizationId,
    { displayName: 'Test Student' },
    db
  )

  // LINK-1 — `answerQuestion` now declines an unconnected person before it
  // ever reaches the allowance or the model (`person.connectedAt === null`).
  // This helper's whole reason to exist is exercising *that* pipeline, not
  // LINK-1's own gate, so the seeded person is connected by default the same
  // way a real one would be after `people.ts#mergePeople` first attaches a
  // second identity — via a real (throwaway) merge, not a raw column write,
  // so this stays a faithful "already connected" person rather than a
  // shortcut this package's own repo would never produce. Tests that want an
  // *unconnected* person for LINK-1 itself pass `connect: false`.
  if (options.connect ?? true) {
    const throwaway = people.createPerson(organizationId, {}, db)
    const merged = people.mergePeople(
      organizationId,
      person.id,
      throwaway.id,
      db
    )
    if (!merged) {
      throw new Error('seedCourseAndPerson: failed to connect the test person')
    }
  }

  return {
    organizationId,
    courseId: courseResult.course.id,
    personId: person.id,
  }
}
