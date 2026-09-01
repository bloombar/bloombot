/**
 * Test helper: the smallest organization/project/course/person graph
 * `answerQuestion` needs — the same helper `packages/core/tests/helpers/seed.ts`
 * defines, duplicated here rather than imported across a package boundary
 * test helpers are not published through. Synthetic data only (QA-3),
 * written through `@bloombot/db`'s own repos.
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
  promptId?: string | null
  instructions?: string | null
  model?: string | null
  vectorStoreId?: string | null
}

/** One organization, one project, one enabled course and one person — enough for `answerQuestion` to run against, this time against a real OpenAI-shaped adapter. */
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
      maxRequestsPerDay: 10,
      promptId: options.promptId ?? null,
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
