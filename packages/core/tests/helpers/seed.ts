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

  return {
    organizationId,
    courseId: courseResult.course.id,
    personId: person.id,
  }
}
