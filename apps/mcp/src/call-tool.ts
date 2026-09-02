/**
 * MCP-1/3/4/5: what happens when this server receives a call for one of
 * `tool-surface.ts`'s allowed tools. Pure — no `@modelcontextprotocol/sdk`
 * import anywhere in this file — so this is testable with a throwaway
 * database and no transport standing up at all (this slice's own brief:
 * "the tool definitions and the dispatch logic should be testable without
 * standing up a transport"). `server.ts` is the only caller in production.
 *
 * Three refusals this file can produce, deliberately not the same shape:
 *
 *  - `UnknownMcpToolError` — the name is not on the allowlist at all
 *    (MCP-2). A protocol-level "no such tool", not a claim about whether a
 *    record exists.
 *  - `ActionRefusedError` (reused from `@bloombot/actions`, not
 *    reimplemented) — either the call is missing/malformed
 *    `organizationId`, or the caller's account holds no membership in the
 *    organization it named. MCP-3's tenancy boundary: a connection carries
 *    exactly the memberships the authenticating account holds and nothing
 *    else, so an organization id it does not belong to refuses exactly the
 *    way `dispatch.ts` refuses any other record the caller cannot see
 *    (TEN-5 — not an existence oracle for organizations the caller does not
 *    belong to either).
 *  - `ConfirmationRequiredError` — MCP-4: a destructive tool's caller did
 *    not have its confirmation granted. Distinguishable from the other two
 *    on purpose — declining a confirmation is not a tenancy oracle, so
 *    there is nothing to hide about it.
 *
 * Whatever `dispatch` itself throws (`ActionInputError`,
 * `ActionRefusedError`, `ActionConflictError`) passes through unchanged —
 * the same errors `apps/api`'s own `errorMiddleware` maps, mapped here to
 * an MCP tool error instead of an HTTP status (`server.ts`'s own job).
 *
 * MCP-5: the one call this file makes to actually do anything is `dispatch`
 * itself — the same function, the same pipeline, `apps/api`'s own
 * `routes/actions.ts` calls. Any action that later gains a real `meter`
 * hook (`packages/actions/src/types.ts`) is metered identically for an MCP
 * caller, because there is no second accounting path here to keep in sync
 * with it — see `docs/DECISIONS.md` D-36 for why this file deliberately
 * computes no cost of its own.
 */

import {
  dispatch,
  ActionRefusedError,
  type ActionRegistry,
} from '@bloombot/actions'
import { memberships, type Database } from '@bloombot/db'
import { z } from 'zod'

import { buildToolDefinitions, type McpToolDefinition } from './tool-surface.js'

/** Pulled out of a tool call's raw arguments before the rest is handed to `dispatch` — every action's own schema omits this field (`tool-surface.ts`'s own doc comment on why). `.passthrough()` so every other argument survives untouched for `dispatch`'s own validation to see. */
const organizationIdSchema = z
  .object({ organizationId: z.string().min(1) })
  .passthrough()

/** MCP-2: the tool name is not on the allowlist. */
export class UnknownMcpToolError extends Error {
  readonly code = 'unknown_tool'
  constructor(name: string) {
    super(`No MCP tool is registered as "${name}".`)
    this.name = 'UnknownMcpToolError'
  }
}

/**
 * MCP-4: thrown when a destructive tool's confirmation was declined, was
 * never granted, or could not even be asked for (`server.ts`'s own
 * `requestConfirmation` fails closed when the connected client cannot
 * elicit one — see its module comment). Distinct from `ActionRefusedError`:
 * see this file's own module comment.
 */
export class ConfirmationRequiredError extends Error {
  readonly code = 'confirmation_required'
  constructor() {
    super('This action deletes, exports or spends money and was not confirmed.')
    this.name = 'ConfirmationRequiredError'
  }
}

export interface CallToolContext {
  registry: ActionRegistry
  db: Database
  /** The account `authenticate.ts` proved the connection is — MCP-1's "an ordinary call by the account that authorized it." */
  accountId: string
  /**
   * MCP-4's mechanical confirmation. Never a boolean argument the caller's
   * own tool-call arguments could carry — see `server.ts`'s own module
   * comment for why an argument the assistant fills in is not a
   * confirmation at all. Called only for a destructive tool, once, after
   * the tenancy check and before `dispatch`; a rejected `Promise` here is
   * treated as "not confirmed", the same as an explicit `false`.
   */
  requestConfirmation: (
    tool: McpToolDefinition,
    organizationId: string
  ) => Promise<boolean>
}

export interface CallToolResult {
  output: unknown
}

/**
 * Runs one MCP tool call end to end: look the tool up on the allowlist,
 * pull `organizationId` out of its arguments and check the caller's own
 * membership in it (MCP-3), ask for confirmation if the tool is destructive
 * (MCP-4), then dispatch through the exact pipeline `apps/api` uses
 * (MCP-1) — the same validation, the same policy, the same metering hook
 * (MCP-5), attributed to `context.accountId` (FILE-4's own `accountId`
 * plumbing through `DispatchContext`).
 */
export async function callTool(
  toolName: string,
  rawArgs: unknown,
  context: CallToolContext
): Promise<CallToolResult> {
  const tool = buildToolDefinitions(context.registry).find(
    (definition) => definition.name === toolName
  )
  if (!tool) throw new UnknownMcpToolError(toolName)

  const parsed = organizationIdSchema.safeParse(rawArgs)
  if (!parsed.success) {
    // A missing or malformed `organizationId` refuses the same way an
    // organization the caller cannot see does (below) — neither tells a
    // caller anything about what does or does not exist.
    throw new ActionRefusedError()
  }
  const { organizationId, ...actionArgs } = parsed.data

  // MCP-3: the tenancy boundary, checked directly — a connection for an
  // account with no membership in `organizationId` is refused exactly the
  // way ACT-3 refuses any other record the caller cannot see.
  const membership = memberships.getMembership(
    organizationId,
    context.accountId,
    context.db
  )
  if (!membership) throw new ActionRefusedError()

  if (tool.destructive) {
    // A `requestConfirmation` that throws or rejects (a client that drops
    // the connection mid-elicitation, say) fails closed the same as an
    // explicit decline — the destructive action still does not run.
    const confirmed = await context
      .requestConfirmation(tool, organizationId)
      .catch(() => false)
    if (!confirmed) throw new ConfirmationRequiredError()
  }

  const output = await dispatch(tool.action, actionArgs, {
    organizationId,
    db: context.db,
    accountId: context.accountId,
  })
  return { output }
}
