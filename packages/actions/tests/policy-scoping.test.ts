/**
 * ACT-2: the entity `execute` receives is the one the policy resolved, and
 * an action cannot reach another organization's record even when it is
 * handed that record's id in its input — the policy is what scopes it, not
 * `execute` reading `input` itself.
 */

import { projects } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { archiveProjectAction } from '../src/actions/projects.js'
import { dispatch } from '../src/dispatch.js'
import { ActionRefusedError } from '../src/errors.js'
import type { Action } from '../src/types.js'
import { seedOrganizationWithProject } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

describe('ACT-2 — the policy scopes the entity execute receives', () => {
  it("a ported action refuses another organization's record, even handed its id, before execute ever runs", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrganizationWithProject(testDb.db)
    const { organizationId: orgB, projectId: projectBId } =
      seedOrganizationWithProject(testDb.db)

    await expect(
      dispatch(
        archiveProjectAction,
        { projectId: projectBId },
        { organizationId: orgA, db: testDb.db }
      )
    ).rejects.toThrow(ActionRefusedError)

    // Org B's project is untouched — the action never reached it, because
    // the policy refused before `execute` (which archives by `entity.id`,
    // never `input.projectId`) ever ran.
    expect(
      projects.getProject(orgB, projectBId, testDb.db)?.archivedAt
    ).toBeNull()
  })

  it('execute receives exactly the entity the policy resolved, not a value execute derives from input itself', async () => {
    testDb = createTestDatabase()
    const { organizationId } = seedOrganizationWithProject(testDb.db)
    const project = projects.createProject(
      organizationId,
      { name: 'Spring 2027' },
      testDb.db
    )

    let receivedEntity: unknown
    const probe: Action<
      'test.probe',
      { projectId: string },
      { id: string; name: string },
      null
    > = {
      name: 'test.probe',
      description: 'Records the entity execute is actually handed.',
      inputSchema: z.object({ projectId: z.string().min(1) }),
      policy: {
        descriptor: { resource: 'project', access: 'read' },
        resolve: (input, context) =>
          projects.getProject(
            context.organizationId,
            input.projectId,
            context.db
          ),
      },
      execute: ({ entity }) => {
        receivedEntity = entity
        return null
      },
    }

    await dispatch(
      probe,
      { projectId: project.id },
      {
        organizationId,
        db: testDb.db,
      }
    )

    expect(receivedEntity).toMatchObject({
      id: project.id,
      name: 'Spring 2027',
    })
  })

  it("archiving through the action does not touch another organization's project of the same shape", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA, projectId: projectAId } =
      seedOrganizationWithProject(testDb.db)
    const { organizationId: orgB, projectId: projectBId } =
      seedOrganizationWithProject(testDb.db)

    await dispatch(
      archiveProjectAction,
      { projectId: projectAId },
      { organizationId: orgA, db: testDb.db }
    )

    expect(
      projects.getProject(orgA, projectAId, testDb.db)?.archivedAt
    ).not.toBeNull()
    // Org B's own project (created independently, in the same call) is
    // untouched — dispatching against org A never reaches it.
    expect(
      projects.getProject(orgB, projectBId, testDb.db)?.archivedAt
    ).toBeNull()
  })
})
