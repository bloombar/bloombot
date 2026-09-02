/**
 * MCP-2: the tool surface is an explicit allowlist, edited deliberately —
 * not everything `packages/actions`' catalog (ACT-6) happens to contain.
 * `MCP_TOOL_SURFACE` below is the only thing that decides what an assistant
 * may reach: registering a new action in `createPlatformRegistry`
 * (`packages/actions/src/actions/index.ts`) does not, by itself, add
 * anything here — a reviewer has to add its name to this array by hand for
 * it to become callable. `tests/tool-surface.test.ts` proves this directly:
 * a fresh action registered into a throwaway registry does not appear in
 * `buildToolDefinitions`'s own output unless this array names it, and that
 * test fails without the allowlist filter in `buildToolDefinitions` below —
 * the requirement is the test, not merely the array.
 *
 * `destructive: true` marks the one action in today's catalog that actually
 * deletes something irreversible (MCP-4: "a tool that deletes, exports, or
 * spends money"). `courseAttachments.detach` removes a knowledge-file both
 * from the model provider and from this platform's own record of it, and
 * there is no `courseAttachments.restore` — see that action's own module
 * comment. Nothing else registered today qualifies: `discordServers.remove`
 * "marks the binding inactive without deleting anything" (its own
 * description), `courseJoinLinks.revoke` disables a link rather than
 * deleting it, `enrolments.end` ends access without discarding the
 * enrolment row (ENRL-6's "ended, not deleted"), and `projects.archive` is
 * reversible by `projects.unarchive`. No action in this catalog exports
 * data or spends money yet (ADMIN-3 is not built; nothing here calls a
 * paid model) — MCP-4's other two triggers have nothing to mark until one
 * does.
 *
 * Deliberately left off this slice's surface, for a future edit to add
 * explicitly rather than by default (`docs/DECISIONS.md` D-36):
 * `courseAttachments.attach` (an arbitrary base64 file upload — a large,
 * unusual argument shape for a model to be filling in without a size
 * conversation this slice has not had), `discordServers.remove`/
 * `.scaffold` (operational actions against a live Discord server —
 * meaningful blast radius for a first cut), `roster.import` (a bulk write
 * of students' own names and emails — PII at a different scale than
 * anything else here), and `memberships.grant` (grants account-level
 * authority within the organization — a privilege change deserving its own
 * confirmation design, not folded into MCP-4's "destructive" bucket as an
 * afterthought).
 */

import type { ActionRegistry, AnyAction } from '@bloombot/actions'
import { z } from 'zod'

/** One entry in the explicit allowlist above. */
interface ToolSurfaceEntry {
  /** The dotted action name this tool dispatches — must be registered in `createPlatformRegistry`; `buildToolDefinitions` throws at startup if it is not (a renamed or removed action should fail loudly, not silently drop a tool a reviewer expects to see). */
  actionName: string
  /** MCP-4 — see this file's own module comment for which actions qualify. Defaults to `false`. */
  destructive?: boolean
}

export const MCP_TOOL_SURFACE: readonly ToolSurfaceEntry[] = [
  // Reads — every one of these declares `access: 'read'` in its own policy
  // descriptor (`packages/actions/tests/access-audit.test.ts` pins that),
  // so nothing in this half of the list can change data.
  { actionName: 'projects.list' },
  { actionName: 'courses.list' },
  { actionName: 'courses.get' },
  { actionName: 'courseAttachments.list' },
  { actionName: 'courseInstructions.list' },
  { actionName: 'discordServers.list' },
  { actionName: 'enrolments.listForPerson' },
  { actionName: 'enrolments.checkAccess' },
  { actionName: 'costLedger.organizationUsage' },
  { actionName: 'jobs.get' },
  // Ordinary writes — reversible, or end/disable access without discarding
  // the record itself (this file's own module comment above).
  { actionName: 'projects.create' },
  { actionName: 'projects.archive' },
  { actionName: 'projects.unarchive' },
  { actionName: 'projects.duplicate' },
  { actionName: 'courses.save' },
  { actionName: 'courses.enable' },
  { actionName: 'courses.disable' },
  { actionName: 'courseInstructions.save' },
  { actionName: 'courseInstructions.restore' },
  { actionName: 'courseJoinLinks.create' },
  { actionName: 'courseJoinLinks.revoke' },
  { actionName: 'enrolments.end' },
  // Destructive — MCP-4.
  { actionName: 'courseAttachments.detach', destructive: true },
]

/**
 * One tool this MCP server exposes, resolved against a real registry:
 * everything `server.ts` needs to register it with the SDK, and everything
 * `call-tool.ts` needs to dispatch it — plain data plus a reference to the
 * action itself, nothing from `@modelcontextprotocol/sdk` anywhere in this
 * file, so both are testable with no transport standing up at all.
 */
export interface McpToolDefinition {
  name: string
  description: string
  /**
   * Real JSON Schema (draft 2020-12) for this tool's arguments — the
   * action's own input schema (`z.toJSONSchema`, the same derivation
   * `ActionRegistry#catalog` (ACT-6) already uses), with `organizationId`
   * merged in as a required top-level property. Every action's own schema
   * omits `organizationId` on purpose (`dispatch.ts`'s own doc comment:
   * "never read out of the action's own input") — a connection
   * authenticates as an account, not a single organization (MCP-3), so
   * which organization a call acts within has to travel as part of the
   * call itself, the same way `apps/api`'s own `:organizationId` route
   * parameter does for the HTTP surface.
   */
  inputSchema: object
  destructive: boolean
  action: AnyAction
}

/** The JSON Schema shape `z.toJSONSchema` produces for a `z.object(...)` — narrow, just enough of it to merge a property in. */
interface ObjectJsonSchema {
  type?: string
  properties?: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

/** Merges a required `organizationId: string` property into an action's own JSON Schema — see `McpToolDefinition.inputSchema`'s own doc comment for why every tool needs one. */
function withOrganizationId(schema: object): object {
  const objectSchema = schema as ObjectJsonSchema
  return {
    ...objectSchema,
    properties: {
      organizationId: {
        type: 'string',
        minLength: 1,
        description:
          'The organization to act within — must be one the connected account belongs to.',
      },
      ...objectSchema.properties,
    },
    required: ['organizationId', ...(objectSchema.required ?? [])],
  }
}

/**
 * Resolves `MCP_TOOL_SURFACE` against a real registry, building the tool
 * definitions `server.ts` registers with the SDK and `call-tool.ts`
 * dispatches through. Throws if the allowlist names an action that is not
 * actually registered — this file's own module comment on why that is a
 * loud failure rather than a silently dropped tool.
 */
export function buildToolDefinitions(
  registry: ActionRegistry
): McpToolDefinition[] {
  return MCP_TOOL_SURFACE.map((entry): McpToolDefinition => {
    const action = registry.get(entry.actionName)
    if (!action) {
      throw new Error(
        `apps/mcp: "${entry.actionName}" is on the MCP tool surface but is not registered in the platform's action registry.`
      )
    }
    return {
      name: action.name,
      description: action.description,
      inputSchema: withOrganizationId(z.toJSONSchema(action.inputSchema)),
      destructive: entry.destructive ?? false,
      action,
    }
  })
}
