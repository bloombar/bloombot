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
 * `destructive: true` marks a tool that deletes, exports, or spends money
 * (MCP-4) and requires `describeTarget` — `buildToolDefinitions` throws at
 * build time if a destructive entry omits one (this file's own module
 * comment further down has why: a confirmation that only names the tool,
 * not the record, is not a real confirmation). Two entries qualify today:
 *
 *   - `courseAttachments.detach` removes a knowledge-file both from the
 *     model provider and from this platform's own record of it, and there
 *     is no `courseAttachments.restore` — see that action's own module
 *     comment.
 *   - `courses.save` **replaces** a course's categories and channels on
 *     every call (its own description: "replacing its categories and
 *     channels") — `packages/actions/src/actions/courses.ts`'s
 *     `updateCourse` deletes every existing category row and re-inserts
 *     from `input.categories`, with no restore path. `saveInputSchema`
 *     makes `categories` required, so a model that resupplies a partial or
 *     stale list — or one that never read the course's current categories
 *     at all — silently discards the rest. This was found live, against a
 *     real SDK client, in this slice's own rework round: `courses.save`
 *     shipped unmarked, with `destructiveHint: false`, and deleted every
 *     category and channel with no elicitation raised at all. Marking it
 *     destructive (rather than dropping it from the surface, the other
 *     option this repository's own review considered) keeps the tool
 *     useful — an instructor's assistant can still rename a course or
 *     toggle it on/off — while requiring a human to actually see what is
 *     about to be replaced before it happens (`describeTarget`, below).
 *     `docs/DECISIONS.md` D-36 has the full record, including why a
 *     partial-update input shape (the real fix) is future work, not this
 *     slice's.
 *
 * Nothing else registered today qualifies: `discordServers.remove` "marks
 * the binding inactive without deleting anything" (its own description),
 * `courseJoinLinks.revoke` disables a link rather than deleting it, and
 * `enrolments.end` ends access without discarding the enrolment row
 * (ENRL-6's "ended, not deleted"). No action in this catalog exports data
 * or spends money yet (ADMIN-3 is not built; nothing here calls a paid
 * model) — MCP-4's other two triggers have nothing to mark until one does.
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
 *
 * `jobs.get` is on the surface, but its output is reduced to an allowlist
 * (`sanitizeOutput`, below: `allowlistJobFields`) — never a denylist of one
 * field at a time. A job's own `payload` can carry whatever the action that
 * enqueued it wrote (`roster.import`'s own is `{ courseId, csvText }`, a
 * raw CSV of students' names and emails) and its `result` can carry
 * whatever the *handler* that ran it wrote back: a completed
 * `roster.import` job's own `RosterImportReport`
 * (`apps/worker/src/handlers/roster-import.ts`) carries a student's email
 * or Discord handle in eight of its own array fields
 * (`unresolvedHandles`, `channelsCreated`, `channelsAlreadyPresent`,
 * `channelAccessGranted`, `channelsNotCreated`, `channelsFailed`,
 * `channelNameCollisions`, `ambiguousHandles`, plus `peopleCreated`/
 * `peopleMerged`/`rosterFieldsDeclined`). `roster.import` itself is
 * deliberately off this surface for exactly that reason (previous
 * paragraph); a first version of this file stripped only `payload` and
 * left `result` untouched, which handed the same PII back through the same
 * tool one job-state later — found live, in this slice's own rework round,
 * by claiming and completing a roster-import job with a real report and
 * reading it straight back through `jobs.get`. Denylisting a second field
 * closes today's finding and reopens the same shape the moment a future
 * handler's own report carries something else this tool has no business
 * repeating — an allowlist does not: `allowlistJobFields` names every field
 * this tool may return, once, and a handler that starts returning a richer
 * `result` does not silently widen what a model can read through it.
 * `jobs.list` is not on the surface either, so a job id is not otherwise
 * guessable from this surface, but that was never the actual guard: this
 * file's own reasoning has to hold regardless of what else is or is not
 * exposed, not lean on an id being hard to find.
 *
 * `lastError` is on the allowlist — checked directly, not merely assumed
 * safe: every `throw` in every handler this catalog registers today
 * (`roster.import`, `courseAttachments.attach`/`.detach`,
 * `discordServers.scaffold`) names a course, an organization, a job kind or
 * a malformed-payload shape, never a row from a roster or a specific
 * student — a per-row failure in `roster.import` (a Discord API error
 * creating one student's channel, say) is caught and pushed into
 * `report.channelsFailed` (still a `result` field, still excluded), never
 * re-thrown to become this job's own `lastError`. This is a property of
 * today's handlers, not one `jobs.get` enforces mechanically — a future
 * handler that threw a per-row error including a student's own address
 * would reopen exactly this shape through the one field this tool does
 * still return, the same way `result` did. See `docs/DECISIONS.md` D-36
 * for the fuller reasoning and what would have to change to make that
 * mechanical rather than reviewed.
 */

import type { ActionRegistry, AnyAction } from '@bloombot/actions'
import { z } from 'zod'

/** One entry in the explicit allowlist above. */
export interface ToolSurfaceEntry {
  /** The dotted action name this tool dispatches — must be registered in `createPlatformRegistry`; `buildToolDefinitions` throws if it is not (a renamed or removed action should fail loudly, not silently drop a tool a reviewer expects to see). */
  actionName: string
  /** MCP-4 — see this file's own module comment for which actions qualify. Defaults to `false`. Requires `describeTarget` when `true` (checked in `buildToolDefinitions`, below). */
  destructive?: boolean
  /**
   * Required whenever `destructive` is `true`. Resolves what a destructive
   * call is actually about to do, in words a human confirming it can act
   * on — a confirmation naming only the tool ("courseAttachments.detach")
   * and a raw organization id is not a real confirmation, because "detach
   * the old syllabus" and "detach the final exam key" would read
   * identically. Handed the entity the action's own `policy.resolve`
   * already resolved (never re-fetched separately — the same record
   * `execute` itself will act on, read once) and the validated input, so a
   * create path with no prior record (`courses.save` with no `id`) can
   * still describe what is about to be created.
   */
  describeTarget?: (entity: unknown, input: unknown) => string
  /**
   * Reduces this tool's own output to what it may actually hand to a model
   * — `jobs.get`'s own `allowlistJobFields` (this file's own module
   * comment on why an allowlist, not a denylist). Applied after `dispatch`
   * succeeds, never before — a refusal or a validation failure never
   * reaches this at all.
   */
  sanitizeOutput?: (output: unknown) => unknown
}

/**
 * `jobs.get`'s own output, reduced to an allowlist — this file's own
 * module comment on why an allowlist, not a denylist, and on why
 * `lastError` is on it. Neither `payload` (what the action that enqueued
 * this job wrote) nor `result` (what the handler that ran it wrote back)
 * is named here, on purpose: whatever either one carries, for any job kind
 * this platform ever registers, stays off this tool's own output unless a
 * future, deliberate edit adds a specific field of one to this list by
 * name — the same "a reviewer has to add it by hand" discipline
 * `MCP_TOOL_SURFACE` itself already holds every tool to.
 */
const JOBS_GET_ALLOWED_FIELDS = [
  'id',
  'kind',
  'status',
  'attempts',
  'maxAttempts',
  'lastError',
  'createdAt',
  'updatedAt',
] as const

function allowlistJobFields(output: unknown): unknown {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return output
  }
  const source = output as Record<string, unknown>
  const allowed: Record<string, unknown> = {}
  for (const field of JOBS_GET_ALLOWED_FIELDS) {
    if (field in source) allowed[field] = source[field]
  }
  return allowed
}

/** `courseAttachments.detach`'s own entity — `packages/actions/src/actions/course-attachments.ts`'s `Attachment`, narrowed to the one field this needs. */
function describeAttachmentTarget(entity: unknown): string {
  const filename = (entity as { filename?: unknown } | null)?.filename
  return typeof filename === 'string'
    ? `the attachment "${filename}"`
    : 'an attachment'
}

/** `courses.save`'s own entity (`CourseSaveEntity`) — an existing course being replaced, or (no `id` in the input) a new one about to be created, in which case there is nothing to destroy yet but the confirmation still names what will exist. */
function describeCourseSaveTarget(entity: unknown, input: unknown): string {
  const existingTitle = (
    entity as { existingCourse?: { title?: unknown } } | null
  )?.existingCourse?.title
  if (typeof existingTitle === 'string') {
    return `the course "${existingTitle}" — every existing category and channel is replaced by what this call supplies`
  }
  const newTitle = (input as { title?: unknown } | null)?.title
  return typeof newTitle === 'string'
    ? `a new course titled "${newTitle}"`
    : 'a new course'
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
  { actionName: 'jobs.get', sanitizeOutput: allowlistJobFields },
  // Ordinary writes — reversible, or end/disable access without discarding
  // the record itself (this file's own module comment above).
  { actionName: 'projects.create' },
  { actionName: 'projects.archive' },
  { actionName: 'projects.unarchive' },
  { actionName: 'projects.duplicate' },
  {
    actionName: 'courses.save',
    destructive: true,
    describeTarget: describeCourseSaveTarget,
  },
  { actionName: 'courses.enable' },
  { actionName: 'courses.disable' },
  { actionName: 'courseInstructions.save' },
  { actionName: 'courseInstructions.restore' },
  { actionName: 'courseJoinLinks.create' },
  { actionName: 'courseJoinLinks.revoke' },
  { actionName: 'enrolments.end' },
  // Destructive — MCP-4.
  {
    actionName: 'courseAttachments.detach',
    destructive: true,
    describeTarget: describeAttachmentTarget,
  },
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
  describeTarget?: (entity: unknown, input: unknown) => string
  sanitizeOutput?: (output: unknown) => unknown
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
 * Resolves `surface` (defaulting to the real `MCP_TOOL_SURFACE`) against a
 * real registry, building the tool definitions `server.ts` registers with
 * the SDK and `call-tool.ts` dispatches through. `surface` is a parameter,
 * not always the module constant, so a test can build definitions around a
 * fake action (a metered one, say — MCP-5's own coverage needs one this
 * platform's real catalog does not have) without touching
 * `MCP_TOOL_SURFACE` itself or `createPlatformRegistry`'s real action set.
 *
 * Throws if an entry names an action that is not actually registered, or
 * is `destructive` with no `describeTarget` — both loud failures at the
 * point this function is called (`index.ts`, once, before this process
 * starts listening) rather than a silently dropped or silently
 * under-described tool discovered later, mid-session.
 */
export function buildToolDefinitions(
  registry: ActionRegistry,
  surface: readonly ToolSurfaceEntry[] = MCP_TOOL_SURFACE
): McpToolDefinition[] {
  return surface.map((entry): McpToolDefinition => {
    const action = registry.get(entry.actionName)
    if (!action) {
      throw new Error(
        `apps/mcp: "${entry.actionName}" is on the MCP tool surface but is not registered in the platform's action registry.`
      )
    }
    if (entry.destructive && !entry.describeTarget) {
      throw new Error(
        `apps/mcp: "${entry.actionName}" is marked destructive but has no describeTarget — a destructive tool's confirmation must name what it is about to do (see this file's own module comment).`
      )
    }
    return {
      name: action.name,
      description: action.description,
      inputSchema: withOrganizationId(z.toJSONSchema(action.inputSchema)),
      destructive: entry.destructive ?? false,
      ...(entry.describeTarget ? { describeTarget: entry.describeTarget } : {}),
      ...(entry.sanitizeOutput ? { sanitizeOutput: entry.sanitizeOutput } : {}),
      action,
    }
  })
}
