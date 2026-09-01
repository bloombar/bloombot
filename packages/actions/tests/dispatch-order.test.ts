/**
 * ACT-4: dispatch validates, authorizes, meters, then executes, in that
 * order, in one place. Proven with recorded calls on an instrumented action
 * rather than by reading `dispatch.ts`'s own source.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { dispatch } from '../src/dispatch.js'
import { ActionInputError, ActionRefusedError } from '../src/errors.js'
import type { Action } from '../src/types.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

interface TestInput {
  id: string
}
interface TestEntity {
  id: string
}

/**
 * A minimal action with every stage instrumented — `calls` records the
 * order stages actually ran in, not the order the source suggests they
 * should. `authorized` controls whether `policy.resolve` refuses;
 * `withMeter: false` omits the (optional) meter entirely, rather than
 * setting it to `undefined` — `exactOptionalPropertyTypes` treats those two
 * differently, and ACT-1's "optional metering hook" means the first is the
 * real case to prove.
 */
function buildRecordingAction(options: {
  authorized: boolean
  withMeter?: boolean
}) {
  const calls: string[] = []
  const resolve = vi.fn((input: TestInput): TestEntity | undefined => {
    calls.push('policy')
    return options.authorized ? { id: input.id } : undefined
  })
  const meter = vi.fn(() => {
    calls.push('meter')
  })
  const execute = vi.fn(() => {
    calls.push('execute')
    return 'done'
  })

  const action: Action<'test.order', TestInput, TestEntity, string> = {
    name: 'test.order',
    description: 'Records the order dispatch actually ran its stages in.',
    inputSchema: z.object({ id: z.string().min(1) }),
    policy: {
      descriptor: { resource: 'test', access: 'write' },
      resolve,
    },
    ...(options.withMeter === false ? {} : { meter }),
    execute,
  }

  return { action, calls, resolve, meter, execute }
}

describe('ACT-4 — dispatch pipeline order', () => {
  it('a call with invalid input never reaches the policy', async () => {
    testDb = createTestDatabase()
    const { action, resolve } = buildRecordingAction({ authorized: true })

    await expect(
      dispatch(action, { id: '' }, { organizationId: 'org-1', db: testDb.db })
    ).rejects.toThrow(ActionInputError)

    expect(resolve).not.toHaveBeenCalled()
  })

  it('an unauthorized call never reaches the meter or execute', async () => {
    testDb = createTestDatabase()
    const { action, meter, execute } = buildRecordingAction({
      authorized: false,
    })

    await expect(
      dispatch(action, { id: 'x' }, { organizationId: 'org-1', db: testDb.db })
    ).rejects.toThrow(ActionRefusedError)

    expect(meter).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('an authorized, metered call runs policy, then meter, then execute — meter exactly once', async () => {
    testDb = createTestDatabase()
    const { action, calls, meter } = buildRecordingAction({ authorized: true })

    const result = await dispatch(
      action,
      { id: 'x' },
      {
        organizationId: 'org-1',
        db: testDb.db,
      }
    )

    expect(result).toBe('done')
    expect(calls).toEqual(['policy', 'meter', 'execute'])
    expect(meter).toHaveBeenCalledTimes(1)
  })

  it('an action with no meter still executes after authorization', async () => {
    testDb = createTestDatabase()
    const { action, calls } = buildRecordingAction({
      authorized: true,
      withMeter: false,
    })

    const result = await dispatch(
      action,
      { id: 'x' },
      {
        organizationId: 'org-1',
        db: testDb.db,
      }
    )

    expect(result).toBe('done')
    expect(calls).toEqual(['policy', 'execute'])
  })
})
