/**
 * ACT-3: a missing id and another tenant's id produce the same refusal —
 * same type, same message, same serialized shape — so an identifier cannot
 * be probed to learn which one happened. Asserted by comparing the
 * serialized error, not just its constructor.
 */

import { randomUUID } from 'node:crypto'

import { afterEach, describe, expect, it } from 'vitest'

import { archiveProjectAction } from '../src/actions/projects.js'
import { dispatch } from '../src/dispatch.js'
import { ActionRefusedError } from '../src/errors.js'
import { seedOrganizationWithProject } from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

/** Everything about an error that could differ between two refusals — name, message, and its one extra field (`code`). Excludes `stack`, which always differs. */
function serializeError(error: unknown) {
  if (!(error instanceof Error)) throw new Error('expected an Error')
  return JSON.stringify({
    name: error.name,
    message: error.message,
    code: (error as ActionRefusedError).code,
  })
}

describe('ACT-3 — refusals reveal nothing', () => {
  it("a missing project id and another organization's project id refuse byte-identically", async () => {
    testDb = createTestDatabase()
    const { organizationId: orgA } = seedOrganizationWithProject(testDb.db)
    const { projectId: otherOrgsProjectId } = seedOrganizationWithProject(
      testDb.db
    )

    const missingError: unknown = await dispatch(
      archiveProjectAction,
      { projectId: randomUUID() },
      { organizationId: orgA, db: testDb.db }
    ).catch((error: unknown) => error)

    const forbiddenError: unknown = await dispatch(
      archiveProjectAction,
      { projectId: otherOrgsProjectId },
      { organizationId: orgA, db: testDb.db }
    ).catch((error: unknown) => error)

    expect(missingError).toBeInstanceOf(ActionRefusedError)
    expect(forbiddenError).toBeInstanceOf(ActionRefusedError)
    expect(serializeError(missingError)).toBe(serializeError(forbiddenError))
  })
})
