/**
 * apps/mcp's own transport adapter — the one file in this app allowed to
 * import `@modelcontextprotocol/sdk`, the same "vendor SDK confined to its
 * own adapter" discipline `apps/bot`'s own module comment holds discord.js
 * to (`packages/discord/tests/no-vendor-sdk.test.ts` enforces that one
 * mechanically across a package boundary; this is a single app with no such
 * boundary to enforce it, so the discipline is held by keeping every SDK
 * import in this one file instead). `tool-surface.ts` and `call-tool.ts` —
 * the tool definitions and the dispatch logic — import nothing from the SDK
 * and are testable with no transport standing up at all.
 *
 * Builds an Express app: `/health` (the same shape `apps/api`'s own
 * `health.ts` uses) and `/mcp`, an MCP Streamable HTTP endpoint run in
 * *stateful* mode — one `McpServer`/`StreamableHTTPServerTransport` pair
 * per session, tracked by the SDK's own `Mcp-Session-Id` header, the shape
 * the SDK's own full-featured example (`simpleStreamableHttp.ts`) uses.
 * Stateless mode (a fresh pair per request, the SDK's `simpleStatelessStreamableHttp.ts`)
 * looked appealing at first — nothing to track between requests — but
 * MCP-4's own confirmation depends on the client's capabilities negotiated
 * during `initialize` (`getClientCapabilities`, `requestElicitedConfirmation`
 * below) still being known by the time a later `tools/call` arrives: a
 * fresh server per request would have thrown that negotiation away between
 * the initialize call and every call after it, silently turning MCP-4's own
 * "fails closed if the client cannot elicit" into "fails closed always."
 * Every dependency is passed in, the same `buildApp`-is-a-function
 * convention `apps/api/src/server.ts` already holds itself to, so a test
 * drives this with `supertest` and no port bound just to run a suite.
 *
 * Authentication happens on every single HTTP request to `/mcp`, not only
 * the one that creates a session (`authenticateBearerToken`, MCP-3) — a
 * request with no valid bearer token never reaches a tool, the same "no
 * session, no dispatch" refusal `apps/api`'s own `routes/actions.ts` gives
 * an anonymous caller, and a session whose token has since expired or been
 * revoked stops working on its very next request rather than staying live
 * until the client disconnects. A session, once created, is also pinned to
 * the account that created it — a bearer token authenticating a *different*
 * account presented against an existing `Mcp-Session-Id` is refused, not
 * silently allowed to reuse another account's already-registered tools.
 */

import { randomUUID } from 'node:crypto'

import type { Express, Request, Response } from 'express'
import express from 'express'

import type { ActionRegistry } from '@bloombot/actions'
import type { Database } from '@bloombot/db'
import type { Logger } from '@bloombot/logger'
import { z, type ZodRawShape } from 'zod'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'

import { authenticateBearerToken, parseBearerToken } from './authenticate.js'
import {
  callTool,
  ConfirmationRequiredError,
  UnknownMcpToolError,
} from './call-tool.js'
import { checkHealth } from './health.js'
import { buildToolDefinitions, type McpToolDefinition } from './tool-surface.js'

export interface ServerDependencies {
  db: Database
  logger: Logger
  registry: ActionRegistry
}

const SERVER_INFO = { name: 'bloombot-mcp', version: '0.1.0' }

/**
 * MCP-4: asks the *client application* to confirm a destructive tool,
 * through `elicitation/create` — an MCP request from this server to the
 * client, distinct from the tool call itself, that the protocol expects
 * the client to put in front of the actual person rather than answer on a
 * model's behalf (`docs/DECISIONS.md` D-36 has the full reasoning for why
 * this, and not a boolean tool argument, is what MCP-4 requires).
 *
 * Fails closed, not merely "skips the check", when the connected client
 * never declared form-elicitation support at all
 * (`getClientCapabilities().elicitation.form`, the exact capability the
 * SDK's own `elicitInput` checks for the default `mode: 'form'` this call
 * uses) — a client that cannot relay a question to a human cannot confirm a
 * destructive action on one's behalf either, so the tool is refused rather
 * than run unconfirmed.
 */
async function requestElicitedConfirmation(
  mcpServer: McpServer,
  tool: McpToolDefinition,
  organizationId: string
): Promise<boolean> {
  if (!mcpServer.server.getClientCapabilities()?.elicitation?.form) {
    return false
  }

  const result = await mcpServer.server.elicitInput({
    message: `Confirm "${tool.name}" in organization ${organizationId}: ${tool.description}`,
    requestedSchema: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          title: 'Confirm',
          description: `Set to true only if you — the person using this assistant — want to proceed with ${tool.name}. The assistant cannot answer this for you.`,
        },
      },
      required: ['confirm'],
    },
  })
  return result.action === 'accept' && result.content?.['confirm'] === true
}

/** How many wrapper layers (`.default(...)`, `.optional()`, ...) `unwrapToObjectSchema` below peels before giving up — generous for the one or two levels any action in this catalog actually nests, a loud failure rather than an infinite loop if a schema is shaped in some way this function does not expect. */
const MAX_UNWRAP_DEPTH = 5

/**
 * `action.inputSchema` is always a `z.object(...)` in this platform's
 * action catalog today, but a zero-argument read (e.g. `projects.list`)
 * wraps it in `.default({})` so a body-less call still validates
 * (`projects.ts`'s own `listInputSchema` doc comment) — `ZodDefault`, not a
 * `ZodObject`, at the top level. `unwrap()` (zod's own accessor for a
 * wrapper type's inner schema) peels that back to the object underneath,
 * the same object `withOrganizationId` (`tool-surface.ts`) merges into for
 * the JSON Schema side of this same tool definition.
 */
function unwrapToObjectSchema(schema: unknown): z.ZodObject<z.ZodRawShape> {
  let current = schema
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    if (current instanceof z.ZodObject) return current
    const unwrap = (current as { unwrap?: () => unknown } | null)?.unwrap
    if (typeof unwrap !== 'function') break
    current = unwrap.call(current)
  }
  throw new Error(
    'apps/mcp: an action input schema is not a plain object schema (even after unwrapping) — cannot merge organizationId into it.'
  )
}

/** The zod-shape equivalent of `tool-surface.ts`'s own `withOrganizationId`, checked at runtime rather than assumed, so a future action with a schema this cannot unwrap fails loudly here instead of registering a broken tool. */
function requireObjectShape(tool: McpToolDefinition): ZodRawShape {
  try {
    return unwrapToObjectSchema(tool.action.inputSchema).shape as ZodRawShape
  } catch {
    throw new Error(
      `apps/mcp: action "${tool.name}"'s input schema is not a plain object schema — cannot merge organizationId into it.`
    )
  }
}

/** Registers every allow-listed tool (`tool-surface.ts`) against `mcpServer`, dispatching each call through `call-tool.ts#callTool` for the account `authenticateBearerToken` already proved this request is. */
function registerTools(
  mcpServer: McpServer,
  deps: ServerDependencies,
  accountId: string
): void {
  for (const tool of buildToolDefinitions(deps.registry)) {
    mcpServer.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: {
          // MCP-3 — see `tool-surface.ts`'s own `McpToolDefinition.inputSchema`
          // doc comment for why every tool needs this beyond its action's
          // own fields.
          organizationId: z
            .string()
            .min(1)
            .describe(
              'The organization to act within — must be one the connected account belongs to.'
            ),
          ...requireObjectShape(tool),
        },
        annotations: {
          readOnlyHint: tool.action.policy.descriptor.access === 'read',
          destructiveHint: tool.destructive,
        },
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        try {
          const result = await callTool(tool.name, args, {
            registry: deps.registry,
            db: deps.db,
            accountId,
            requestConfirmation: (confirmingTool, organizationId) =>
              requestElicitedConfirmation(
                mcpServer,
                confirmingTool,
                organizationId
              ),
          })
          return {
            content: [{ type: 'text', text: JSON.stringify(result.output) }],
          }
        } catch (error) {
          return {
            isError: true,
            content: [{ type: 'text', text: describeToolError(error) }],
          }
        }
      }
    )
  }
}

/** Maps a thrown error to the text an MCP client sees in an `isError` tool result — the same "typed errors, mapped in one place" discipline `packages/actions/src/errors.ts`'s own `HTTP_STATUS_BY_ACTION_ERROR` holds `apps/api`'s error middleware to, mapped to plain text instead of an HTTP status here since a tool result has no status line of its own. */
function describeToolError(error: unknown): string {
  if (
    error instanceof UnknownMcpToolError ||
    error instanceof ConfirmationRequiredError
  ) {
    return error.message
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code
    if (code === 'action_refused') {
      return 'This record does not exist or you do not have access to it.'
    }
    if (code === 'action_input_invalid') {
      return 'The input for this action failed validation.'
    }
    if (code === 'action_conflict' && error instanceof Error) {
      return error.message
    }
  }
  return 'This request could not be completed.'
}

function buildMcpServer(
  deps: ServerDependencies,
  accountId: string
): McpServer {
  const mcpServer = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
  })
  registerTools(mcpServer, deps, accountId)
  return mcpServer
}

/** One live MCP session: the transport the SDK tracks by its own `Mcp-Session-Id`, and the account it was created for (checked again on every later request, this file's own module comment). */
interface McpSession {
  transport: StreamableHTTPServerTransport
  accountId: string
}

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  })
}

export function buildApp(deps: ServerDependencies): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json())

  app.get('/health', (_req, res) => {
    const status = checkHealth(deps.db)
    res.status(status.ready ? 200 : 503).json(status)
  })

  // MCP-3 — this file's own module comment: one map entry per live
  // session, each pinned to the account that created it. Scoped to one
  // `buildApp` call (so a test gets a fresh, empty map every time it builds
  // its own app) rather than module-level state.
  const sessions = new Map<string, McpSession>()

  const mcpHandler = (req: Request, res: Response): void => {
    void handleMcpRequest(req, res, deps, sessions)
  }
  app.post('/mcp', mcpHandler)
  app.get('/mcp', mcpHandler)
  app.delete('/mcp', mcpHandler)

  return app
}

/** Reads and validates the `Mcp-Session-Id` header the SDK's own transport expects on every non-initializing request. */
function sessionIdHeader(req: Request): string | undefined {
  const header = req.headers['mcp-session-id']
  return typeof header === 'string' ? header : undefined
}

async function handleMcpRequest(
  req: Request,
  res: Response,
  deps: ServerDependencies,
  sessions: Map<string, McpSession>
): Promise<void> {
  // MCP-3 — no session, no tool call: an unauthenticated request never
  // reaches this endpoint's own logic, the same refusal shape `apps/api`'s
  // own `routes/actions.ts` gives an anonymous caller. Checked on every
  // request, not only the one that creates an MCP session (this file's own
  // module comment on why).
  const accountId = authenticateBearerToken(
    parseBearerToken(req.headers.authorization),
    deps.db
  )
  if (!accountId) {
    jsonRpcError(res, 401, 'not_signed_in')
    return
  }

  try {
    const existingSessionId = sessionIdHeader(req)
    const existing = existingSessionId
      ? sessions.get(existingSessionId)
      : undefined

    if (existing) {
      // MCP-3 — a session is pinned to the account that created it; a
      // bearer token now authenticating a *different* account must not
      // reuse it, the same "carries that account's memberships and nothing
      // more" guarantee applied to the session itself, not only to a single
      // tool call.
      if (existing.accountId !== accountId) {
        jsonRpcError(res, 401, 'not_signed_in')
        return
      }
      await existing.transport.handleRequest(req, res, req.body)
      return
    }

    if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
      // GET/DELETE need an existing session (a stream to resume, or to
      // close); POST needs either an existing session or a fresh
      // `initialize` — anything else names a session this process has
      // never heard of, or no longer holds (this process restarted, or the
      // session's own transport already closed it).
      jsonRpcError(res, 404, 'session not found')
      return
    }

    const mcpServer = buildMcpServer(deps, accountId)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, accountId })
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId)
      },
    })
    // The SDK's own `StreamableHTTPServerTransport` declares `implements
    // Transport`, but its `onclose`/`onerror`/`onmessage` setters make it
    // structurally incompatible with `Transport`'s plain optional
    // properties under this `tsconfig.base.json`'s
    // `exactOptionalPropertyTypes` — a known friction between that flag and
    // accessor-typed members, not a real mismatch (the SDK's own
    // declaration already asserts the class satisfies the interface).
    // `unknown` is the ordinary escape for a type-checker disagreement like
    // this one, not a claim that `transport` is actually untyped.
    await mcpServer.connect(
      transport as unknown as Parameters<typeof mcpServer.connect>[0]
    )
    await transport.handleRequest(req, res, req.body)
  } catch (error) {
    deps.logger.error({ err: error }, 'apps/mcp: failed to handle a request')
    if (!res.headersSent) {
      jsonRpcError(res, 500, 'internal_error')
    }
  }
}
