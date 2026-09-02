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
 * Builds an Express app: `/health` and `/mcp`, an MCP Streamable HTTP
 * endpoint run in *stateful* mode — one `McpServer`/`StreamableHTTPServerTransport`
 * pair per session, tracked by the SDK's own `Mcp-Session-Id` header, the
 * shape the SDK's own full-featured example (`simpleStreamableHttp.ts`)
 * uses. Stateless mode (a fresh pair per request, the SDK's
 * `simpleStatelessStreamableHttp.ts`) looked appealing at first — nothing
 * to track between requests — but MCP-4's own confirmation depends on the
 * client's capabilities negotiated during `initialize` (`getClientCapabilities`,
 * `requestElicitedConfirmation` below) still being known by the time a
 * later `tools/call` arrives: a fresh server per request would have thrown
 * that negotiation away between the initialize call and every call after
 * it. Every dependency is passed in, the same `buildApp`-is-a-function
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
 *
 * A session's own lifecycle (this file's own rework, after a live-listener
 * repro reproduced unbounded growth: ~170 KB retained per abandoned
 * session, no bound at all on how many one account could open) is bounded
 * three ways, all in this file: `transport.onclose` is wired so a session
 * the SDK itself considers closed is removed from `sessions` the moment it
 * happens, not only when the SDK's own `onsessionclosed` fires (that one
 * only fires for a client-driven `DELETE`, never for this process closing a
 * transport itself, e.g. from the idle sweep below — wiring `onclose`
 * instead of duplicating a `sessions.delete` at every call site that closes
 * a transport is what keeps those two ways of ending a session from
 * drifting apart); `MAX_SESSIONS_PER_ACCOUNT` evicts the account's own
 * oldest session once a new one would put it over the cap, rather than
 * refusing the new one — see `evictOldestSessionForAccount`'s own call site
 * for why refusing punished an ordinary client for merely reconnecting; and
 * `sweepIdleSessions` — a pure function, tested directly with an injected
 * clock rather than a real timer — closes whatever has not made a request
 * in `SESSION_IDLE_TIMEOUT_MS`, run on an interval `buildApp` starts and
 * `.unref()`s so it never itself keeps this process alive.
 */

import { randomUUID } from 'node:crypto'

import type { Express, Request, Response } from 'express'
import express from 'express'

import type { Database } from '@bloombot/db'
import type { Logger } from '@bloombot/logger'
import { z, type ZodRawShape } from 'zod'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js'
import {
  ElicitResultSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js'

import { authenticateBearerToken, parseBearerToken } from './authenticate.js'
import {
  callTool,
  ConfirmationRequiredError,
  InvalidToolArgumentsError,
  UnknownMcpToolError,
} from './call-tool.js'
import { checkHealth } from './health.js'
import type { McpToolDefinition } from './tool-surface.js'

export interface ServerDependencies {
  db: Database
  logger: Logger
  /** Built once, before this process starts listening (`index.ts`) — `call-tool.ts`'s own `CallToolContext.toolDefinitions` doc comment on why this is precomputed rather than rebuilt per call or per session. */
  toolDefinitions: readonly McpToolDefinition[]
  /**
   * How long an `elicitation/create` request waits for a human before
   * giving up. Defaults to `DEFAULT_ELICITATION_TIMEOUT_MS` (30s);
   * injectable so a test can drive it down to a couple of seconds rather
   * than share this process's own production ceiling.
   *
   * Rework finding: this used to be a module-level constant equal to
   * `30_000` — the exact same number `vitest.config.ts`'s own root
   * `testTimeout` carries (inherited in a later rebase, after this
   * constant was already written). A CI run showed two failures landing at
   * 30008ms/30006ms — a hung elicitation and a vitest test timeout are
   * indistinguishable at that point: the server sits for its own full
   * budget, vitest kills the test at essentially the same instant, and the
   * report says nothing about which end actually stalled. Making this
   * injectable, and `tests/mcp-e2e.test.ts` passing a value an order of
   * magnitude below `testTimeout`, means a genuine hang now fails fast
   * with `ConfirmationRequiredError`'s own message well before vitest's
   * own ceiling, instead of dying at it.
   */
  elicitationTimeoutMs?: number
}

const SERVER_INFO = { name: 'bloombot-mcp', version: '0.1.0' }

/**
 * The production default for `ServerDependencies.elicitationTimeoutMs`
 * (`index.ts` never overrides it). The SDK's own default
 * (`DEFAULT_REQUEST_TIMEOUT_MSEC`) is 60 seconds — reasonable for an
 * ordinary request/response, too long for a single `tools/call` to sit
 * open waiting on a person who may never answer at all (declining the
 * confirmation is the safe fallback either way — MCP-4 fails closed on a
 * timeout the same as an explicit decline — but a caller holding a
 * connection open for a full minute is needless latency for no benefit).
 * Thirty seconds is enough to read a short confirmation and decide, short
 * enough that an abandoned call frees the connection quickly.
 */
export const DEFAULT_ELICITATION_TIMEOUT_MS = 30_000

/**
 * MCP-4: asks the *client application* to confirm a destructive tool,
 * through `elicitation/create` — an MCP request from this server to the
 * client, distinct from the tool call itself, that the protocol expects
 * the client to put in front of the actual person rather than answer on a
 * model's behalf (`docs/DECISIONS.md` D-36 has the full reasoning for why
 * this, and not a boolean tool argument, is what MCP-4 requires).
 * `targetLabel` (`call-tool.ts`'s own `resolveTargetLabel`) is what makes
 * the question mean something specific — "detach the old syllabus", not
 * merely "run courseAttachments.detach" — a confirmation naming only the
 * tool and a raw organization id could not be told apart from a
 * confirmation for any other record the same tool might ever touch.
 *
 * Sent through `extra.sendRequest` — the tool call's own
 * `RequestHandlerExtra`, not `mcpServer.server.elicitInput(...)` — and this
 * is load-bearing, not a style choice. `extra.sendRequest` automatically
 * associates the outgoing `elicitation/create` with the *incoming*
 * `tools/call` request it was raised from (the SDK's own
 * `relatedRequestId`, the SDK's own `shared/protocol.js#fullExtra.sendRequest`),
 * which is what tells `StreamableHTTPServerTransport#send` to write the
 * message onto that `tools/call`'s own POST response stream — a stream
 * that, by definition, is already open, because it is the very request
 * this handler is in the middle of answering. Calling `elicitInput`
 * directly (a rework finding: this function used to) sends with no
 * `relatedRequestId` at all, which the transport treats as an unsolicited
 * push and routes onto the *standalone* `GET /mcp` stream instead — a
 * stream the SDK client opens lazily, fire-and-forget, only after its own
 * `notifications/initialized` round trip completes, with nothing that
 * makes `client.connect()` wait for it. When a `tools/call` lands before
 * that GET has finished connecting server-side,
 * `webStandardStreamableHttp.js#send`'s own standalone-stream branch finds
 * no stream registered and returns having done nothing at all — no error,
 * no queue, the message is simply dropped — so the server's own
 * `elicitInput` waits out its full timeout for an answer that was never
 * delivered, and fails closed *as if* declined, with no confirmation ever
 * having reached a human. Reproduced directly (delaying the client's own
 * GET by 300ms against a real connection makes it reproduce on every run;
 * an undelayed one never does — the race, not a logic error, that CI's own
 * slower runner was hitting and this machine was not) before this fix, and
 * confirmed gone after it, the same way.
 *
 * Fails closed, not merely "skips the check", when the connected client
 * never declared form-elicitation support at all
 * (`getClientCapabilities().elicitation.form`, the same capability the
 * SDK's own `elicitInput` checks for the default `mode: 'form'` this call
 * still uses) — a client that cannot relay a question to a human cannot
 * confirm a destructive action on one's behalf either, so the tool is
 * refused rather than run unconfirmed. `ElicitResultSchema` still
 * validates the shape of whatever comes back, the one piece of
 * `elicitInput`'s own convenience this loses by going around it —
 * `elicitInput` additionally validates an *accepted* form response's
 * `content` against the `requestedSchema` this call sent; this function's
 * own check below (`content?.['confirm'] === true`) only ever trusts that
 * one field regardless, so the narrower validation costs nothing this
 * function actually relied on.
 */
async function requestElicitedConfirmation(
  mcpServer: McpServer,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  tool: McpToolDefinition,
  organizationId: string,
  targetLabel: string,
  elicitationTimeoutMs: number
): Promise<boolean> {
  if (!mcpServer.server.getClientCapabilities()?.elicitation?.form) {
    return false
  }

  const result = await extra.sendRequest(
    {
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: `Confirm ${tool.name}: ${targetLabel} (organization ${organizationId}). This cannot be undone by this assistant.`,
        requestedSchema: {
          type: 'object',
          properties: {
            confirm: {
              type: 'boolean',
              title: 'Confirm',
              description: `Set to true only if you — the person using this assistant — want to proceed. The assistant cannot answer this for you.`,
            },
          },
          required: ['confirm'],
        },
      },
    },
    ElicitResultSchema,
    { timeout: elicitationTimeoutMs }
  )
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
  const elicitationTimeoutMs =
    deps.elicitationTimeoutMs ?? DEFAULT_ELICITATION_TIMEOUT_MS
  for (const tool of deps.toolDefinitions) {
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
      async (
        args: Record<string, unknown>,
        extra: RequestHandlerExtra<ServerRequest, ServerNotification>
      ): Promise<CallToolResult> => {
        try {
          const result = await callTool(tool.name, args, {
            toolDefinitions: deps.toolDefinitions,
            db: deps.db,
            accountId,
            requestConfirmation: (
              confirmingTool,
              organizationId,
              targetLabel
            ) =>
              requestElicitedConfirmation(
                mcpServer,
                extra,
                confirmingTool,
                organizationId,
                targetLabel,
                elicitationTimeoutMs
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
    error instanceof ConfirmationRequiredError ||
    error instanceof InvalidToolArgumentsError
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

/** One live MCP session: the transport the SDK tracks by its own `Mcp-Session-Id`, the account it was created for (checked again on every later request, this file's own module comment), and when it last actually did something (`sweepIdleSessions`'s own clock). */
export interface McpSession {
  transport: StreamableHTTPServerTransport
  accountId: string
  lastActivityAt: number
}

/**
 * A ceiling on live sessions per account — the other half of the leak this
 * file's own module comment describes: even with every session eventually
 * reclaimed (`sweepIdleSessions`), nothing bounded how many one account
 * could hold open *at once*, and a live listener measured a single account
 * looping `initialize` retaining hundreds of megabytes well before any idle
 * timeout would have fired. Generous for a real assistant, which holds one
 * or a handful of concurrent sessions, not dozens.
 */
export const MAX_SESSIONS_PER_ACCOUNT = 20

/** How long a session may sit with no request against it before `sweepIdleSessions` closes it — long enough that a real, slow-thinking human confirming a destructive tool is never caught by it (MCP-4's own `ELICITATION_TIMEOUT_MS` is a full order of magnitude shorter), short enough that an abandoned session does not outlive the session it was ever going to matter for. */
export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000

/** How often `buildApp`'s own interval runs `sweepIdleSessions` — frequent enough that "idle" has a bound worth the name, infrequent enough that it is not itself meaningful load. */
export const SESSION_SWEEP_INTERVAL_MS = 5 * 60 * 1000

/**
 * Closes and evicts every session that has not made a request since
 * `now - idleTimeoutMs`. A pure function of its three arguments — no clock
 * of its own, no timer — so a test drives it with a synthetic `now` and an
 * in-memory map instead of waiting on a real interval. Returns the ids
 * closed, for a caller (a test, or this file's own logging) that wants to
 * know what happened without re-deriving it from the map's own before/after
 * size.
 *
 * Deletes from `sessions` directly, synchronously, rather than only calling
 * `transport.close()` and waiting for `onclose` to do it — `onclose` still
 * fires and still deletes (harmlessly, the same id, a no-op the second
 * time), but a caller of this function does not have to await a promise to
 * know the map already reflects the sweep.
 */
export function sweepIdleSessions(
  sessions: Map<string, McpSession>,
  now: number,
  idleTimeoutMs: number
): string[] {
  const closed: string[] = []
  for (const [sessionId, session] of sessions) {
    if (now - session.lastActivityAt < idleTimeoutMs) continue
    sessions.delete(sessionId)
    closed.push(sessionId)
    void session.transport.close()
  }
  return closed
}

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  })
}

/**
 * `sessions` is an optional, injectable parameter — MCP-3's own map,
 * defaulting to a fresh, empty one so ordinary callers (`index.ts`, most
 * of this app's own tests) never have to think about it. A test that needs
 * to reach inside a live session after it exists (proving `transport.onclose`
 * actually evicts the map entry when the transport itself closes, not only
 * when a client sends `DELETE`) builds its own map and passes it in, then
 * reads it directly rather than only observing HTTP responses.
 *
 * `isShuttingDown` — rework finding: an earlier version of `/health` kept
 * reporting `ready: true` for this process's entire teardown window, the
 * same "healthy report over something already going away" shape this
 * rework round already fixed once (`buildToolDefinitions` at startup, D-36).
 * Defaults to `() => false`; `index.ts` passes a closure over its own
 * `shuttingDown` flag, the same device `apps/bot`'s own `gatewayConnected`
 * and `apps/worker`'s own `shuttingDown` already thread into their health
 * endpoints.
 */
export function buildApp(
  deps: ServerDependencies,
  sessions: Map<string, McpSession> = new Map(),
  isShuttingDown: () => boolean = () => false
): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json())

  app.get('/health', (_req, res) => {
    const status = checkHealth(deps.db, sessions.size, isShuttingDown())
    res.status(status.ready ? 200 : 503).json(status)
  })

  // This file's own module comment — bounds how long an abandoned session
  // survives even if nothing ever closes it explicitly. `.unref()` so this
  // timer never itself keeps the process (or a test's own event loop)
  // alive; a test exercises `sweepIdleSessions` directly instead of waiting
  // on this interval.
  const sweepInterval = setInterval(() => {
    sweepIdleSessions(sessions, Date.now(), SESSION_IDLE_TIMEOUT_MS)
  }, SESSION_SWEEP_INTERVAL_MS)
  sweepInterval.unref()

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

/** How many live sessions `accountId` currently holds — `MAX_SESSIONS_PER_ACCOUNT`'s own check. */
function sessionCountForAccount(
  sessions: Map<string, McpSession>,
  accountId: string
): number {
  let count = 0
  for (const session of sessions.values()) {
    if (session.accountId === accountId) count++
  }
  return count
}

/**
 * Closes and evicts `accountId`'s own least-recently-active session —
 * `MAX_SESSIONS_PER_ACCOUNT`'s own eviction half (this file's own module
 * comment). `undefined` if the account holds none (unreachable from this
 * function's one caller, which only reaches here once the cap is already
 * met, but guarded rather than assumed).
 */
function evictOldestSessionForAccount(
  sessions: Map<string, McpSession>,
  accountId: string
): string | undefined {
  let oldestId: string | undefined
  let oldestSession: McpSession | undefined
  for (const [sessionId, session] of sessions) {
    if (session.accountId !== accountId) continue
    if (
      !oldestSession ||
      session.lastActivityAt < oldestSession.lastActivityAt
    ) {
      oldestId = sessionId
      oldestSession = session
    }
  }
  if (oldestId) {
    sessions.delete(oldestId)
    void oldestSession?.transport.close()
  }
  return oldestId
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
      existing.lastActivityAt = Date.now()
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

    if (
      sessionCountForAccount(sessions, accountId) >= MAX_SESSIONS_PER_ACCOUNT
    ) {
      // This file's own module comment — the ceiling half of the session
      // lifecycle rework, and its own rework: an earlier version refused
      // the new session outright (`429`) once an account hit the cap, which
      // punished an *ordinary* client for reconnecting. `StreamableHTTPClientTransport#close()`
      // — what a normal client calls on an ordinary disconnect — does not
      // send `DELETE`; only its own `terminateSession()` does, so a
      // restarted assistant leaves its old session in this map until the
      // idle sweep eventually reaps it. Twenty reconnects inside the sweep
      // window (measured live: 20 connect→`close()` cycles left
      // `sessions.size === 20`, and the 21st was refused) is not exotic.
      // Evicting the account's own oldest session instead means a
      // legitimate reconnect is never refused — it costs the account's own
      // least-recently-active session, never someone else's, and never a
      // refusal a real assistant would have no good way to recover from.
      evictOldestSessionForAccount(sessions, accountId)
    }

    const mcpServer = buildMcpServer(deps, accountId)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, {
          transport,
          accountId,
          lastActivityAt: Date.now(),
        })
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId)
      },
    })
    // This file's own module comment — `onsessionclosed` above only fires
    // for a client-driven `DELETE`; `onclose` fires whenever the transport
    // itself considers the session over for *any* reason, including this
    // process closing it itself (`sweepIdleSessions`). Wired here, before
    // `connect`, using the transport's own `sessionId` getter rather than
    // capturing the id in a second closure — by the time `onclose` can
    // fire, `onsessioninitialized` above has already run and set it.
    transport.onclose = () => {
      const sessionId = transport.sessionId
      if (sessionId) sessions.delete(sessionId)
    }
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
