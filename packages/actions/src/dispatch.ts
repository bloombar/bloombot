/**
 * ACT-4's dispatch pipeline: validate, authorize, meter, execute — in that
 * order, in this one place. Every surface that writes through the platform
 * (the API and the MCP server, neither built yet) calls this, never
 * `action.execute` directly, so an assistant's call is an ordinary call by
 * the account that authorized it (ACT-1) rather than a parallel
 * implementation with its own rules.
 *
 * Dependencies are threaded through `DispatchContext` rather than imported,
 * the same convention `packages/core/src/answer.ts` holds itself to
 * (CORE-4) — this package never opens its own database connection.
 */

import type { Database } from '@bloombot/db'

import { ActionInputError, ActionRefusedError } from './errors.js'
import type { Action } from './types.js'

/** What every `dispatch` call is handed rather than importing. */
export interface DispatchContext {
  /** The organization the caller is acting within — established by whatever authenticated the caller (not built in this slice), never read out of the action's own input. */
  organizationId: string
  db: Database
  /**
   * FILE-4 — the account that authenticated the call, when the caller has
   * one (`apps/api`'s own `routes/actions.ts` passes `req.session.accountId`
   * through; a caller with no session cannot reach `dispatch` at all —
   * that router's own module comment). Optional here rather than required
   * on every `DispatchContext`: most actions today have no reason to know
   * who is calling — `organizationId` alone already decides what they may
   * reach — and adding a mandatory field to this interface would force
   * every existing test and caller to supply one it never uses.
   * `courseInstructions.save`/`.restore` (`actions/course-instructions.ts`)
   * are the first actions that actually read this, to record a revision's
   * own author; a caller of either through `dispatch` with no `accountId`
   * is refused (`ActionRefusedError`) — never recorded as authored by
   * nobody, and never accepted from the action's own input (the same
   * "never read out of the action's own input" discipline `organizationId`
   * above already holds itself to — a self-reported author would be a
   * forgeable audit trail).
   */
  accountId?: string
}

/**
 * Run one action end to end.
 *
 * 1. **Validate** `rawInput` against `action.inputSchema`. A failure never
 *    reaches the policy (ACT-4): `ActionInputError`, thrown.
 * 2. **Authorize.** `action.policy.resolve` turns the validated input into
 *    the tenant-scoped entity `execute` will receive, or refuses. A refusal
 *    is `ActionRefusedError` (ACT-3) — thrown before metering or execution,
 *    so an unauthorized call never consumes an allowance (ACT-4).
 * 3. **Meter**, if the action declares one — after authorization,
 *    deliberately: ACT-2's "authorization runs outside the usage
 *    attribution context" means a policy itself never meters, but a call
 *    that *fails* authorization must not be metered either.
 * 4. **Execute**, handed the organization id, the validated input, the
 *    resolved entity, and the open database — never `rawInput` itself.
 */
export async function dispatch<Name extends string, Input, Entity, Output>(
  action: Action<Name, Input, Entity, Output>,
  rawInput: unknown,
  context: DispatchContext
): Promise<Output> {
  const parsed = action.inputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new ActionInputError(parsed.error.issues)
  }
  const input = parsed.data

  const entity = action.policy.resolve(input, {
    organizationId: context.organizationId,
    db: context.db,
  })
  if (entity === undefined) {
    throw new ActionRefusedError()
  }

  if (action.meter) {
    await action.meter({
      organizationId: context.organizationId,
      input,
      entity,
    })
  }

  return action.execute({
    organizationId: context.organizationId,
    input,
    entity,
    db: context.db,
    ...(context.accountId !== undefined
      ? { accountId: context.accountId }
      : {}),
  })
}
