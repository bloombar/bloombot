/**
 * apps/mcp's own transport adapter — one of two files in this app allowed to
 * import `@modelcontextprotocol/sdk` (`oauth-provider.ts` is the other, for
 * MCP-7's own auth subsystem; that file's own module comment), the same
 * "vendor SDK confined to its own adapter" discipline `apps/bot`'s own
 * module comment holds discord.js to (`packages/discord/tests/no-vendor-sdk.test.ts`
 * enforces that one mechanically across a package boundary; this is a
 * single app with no such boundary to enforce it, so the discipline is held
 * by keeping every SDK import in these two files instead). `tool-surface.ts`
 * and `call-tool.ts` — the tool definitions and the dispatch logic — import
 * nothing from the SDK and are testable with no transport standing up at
 * all.
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
 * the one that creates a session (MCP-3) — a request with no valid bearer
 * token never reaches a tool, the same "no session, no dispatch" refusal
 * `apps/api`'s own `routes/actions.ts` gives an anonymous caller, and a
 * session whose token has since expired, been revoked, or been rotated away
 * stops working on its very next request rather than staying live until
 * the client disconnects. A session, once created, is also pinned to the
 * account that created it — a bearer token authenticating a *different*
 * account presented against an existing `Mcp-Session-Id` is refused, not
 * silently allowed to reuse another account's already-registered tools.
 *
 * **MCP-7 — two bearer shapes, one pinning rule.** `resolveCallerAccountId`
 * (below) tries an OAuth access token first (`oauth-provider.ts#verifyAccessToken`,
 * the primary path a real ChatGPT/Claude connector uses after
 * `mcpAuthRouter`'s own `/authorize`/`/token` complete) and falls back to
 * MCP-3's original bearer session token (`authenticateBearerToken`) when
 * that fails — a deliberate decision to keep both rather than migrate
 * MCP-3 to OAuth-only (`docs/DECISIONS.md`'s MCP-7 entry has the full
 * reasoning): `bloombot_connectAssistant` and this app's own existing test
 * suite depend on a session token working exactly as it does today, and
 * retiring it is a separate decision with its own blast radius this slice
 * does not take. The two are never confused for one another — an OAuth
 * token is a hash lookup against `mcp_oauth_access_tokens`, a session
 * token against `sessions`, and neither table's hash space overlaps the
 * other's (both are 256-bit CSPRNG secrets, `@bloombot/auth`'s own
 * `secrets.ts`) — so a token minted by one path can never be accepted by
 * the other's own check. `mcpAuthRouter` itself (`buildApp`, below) is
 * mounted at this app's own root, publishing `/authorize`, `/token`,
 * `/register`, `/revoke` and both metadata documents alongside `/mcp` and
 * `/health` — the SDK's own required mounting point
 * (`server/auth/router.js`'s own doc comment: "This router MUST be
 * installed at the application root").
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

import { issueMcpPersonLinkToken } from '@bloombot/auth'
import type { ModelClient, PricingTable } from '@bloombot/core'
import { organizations, type Database } from '@bloombot/db'
import type { AdmissionGate } from '@bloombot/jobs'
import type { Logger } from '@bloombot/logger'
import { z, type ZodRawShape } from 'zod'

import {
  createOAuthMetadata,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js'
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js'
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

import { listAdministeredCourses } from './admin-tools.js'
import { authenticateBearerToken, parseBearerToken } from './authenticate.js'
import {
  callTool,
  ConfirmationRequiredError,
  InvalidToolArgumentsError,
  UnknownMcpToolError,
} from './call-tool.js'
import {
  askChatQuestion,
  isAccountLinked,
  listAskableCourses,
  type AskChatResult,
} from './chat-tools.js'
import { checkHealth } from './health.js'
import {
  MCP_ADMIN_TOOL_SURFACE,
  MCP_CHAT_TOOL_SURFACE,
  type McpToolDefinition,
} from './tool-surface.js'

export interface ServerDependencies {
  db: Database
  logger: Logger
  /** Built once, before this process starts listening (`index.ts`) — `call-tool.ts`'s own `CallToolContext.toolDefinitions` doc comment on why this is precomputed rather than rebuilt per call or per session. */
  toolDefinitions: readonly McpToolDefinition[]
  /**
   * MCP-7 — `oauth-provider.ts#buildOauthProvider`'s own return value.
   * `mcpAuthRouter` (`buildApp`, below) dispatches every `/authorize`,
   * `/token`, `/register` and `/revoke` request to it, and
   * `resolveCallerAccountId` (below) calls its `verifyAccessToken` directly
   * as the first of the two bearer shapes a `/mcp` request may now carry
   * (this file's own module comment).
   */
  oauthProvider: OAuthServerProvider
  /**
   * The OAuth issuer identifier `mcpAuthRouter`'s own metadata documents
   * publish — `CONFIG.PUBLIC_MCP_URL`, or a loopback fallback, in
   * production (`index.ts`); an `http://127.0.0.1:0`-shaped URL a test
   * builds against its own ephemeral port. Must be HTTPS unless the
   * hostname is `localhost`/`127.0.0.1` — the SDK's own `checkIssuerUrl`
   * (`router.js`) enforces this, not this file.
   */
  issuerUrl: URL
  /**
   * MCP-7's own RFC 8707 resource identifier — this server's own `/mcp`
   * endpoint, published in the protected-resource metadata document and
   * checked (loosely: only when both sides actually name one) in
   * `oauth-provider.ts#verifyAccessToken`. Defaults to `${issuerUrl}/mcp`.
   */
  resourceServerUrl?: URL
  /**
   * MCP-8: the same three answering seams `apps/api`'s and `apps/bot`'s own
   * `main()` build for `@bloombot/core#answerQuestion` — this process needs
   * them too, for `registerChatTools`' own two tools, for the identical
   * reason `routes/chat.ts`'s own module comment gives ("a different
   * adapter, not a different brain"). All three are optional, the same
   * "expose the seam, default to the safe choice" discipline
   * `AnswerDependencies`' own fields hold themselves to (`answer.ts`'s own
   * module comment) — `index.ts` wires the real, configured ones; a test
   * that does not care about `chat.ask` at all omits every one of them and
   * `registerChatTools` (below) falls back to `UNCONFIGURED_MODEL_CLIENT`,
   * the identical `createUnconfiguredModelClient` shape `index.ts`'s own
   * module comment describes, and `answerQuestion`'s own remaining
   * defaults.
   */
  model?: ModelClient
  admission?: AdmissionGate
  pricing?: PricingTable
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

/**
 * LINK-8: a single tool, registered directly rather than through
 * `tool-surface.ts`'s own allowlist — this mints a person-link token, not a
 * call through `dispatch()`, so it shares none of `registerTools`'s own
 * shape (no `organizationId`-merged action schema, no membership check, no
 * destructive-confirmation path: issuing a token binds nothing yet, only a
 * later `POST .../person-link/mcp/confirm` on the panel spends it).
 *
 * The identity this tool connects is fixed to `accountId` — the account
 * `authenticateBearerToken` already proved this whole connection is (MCP-3:
 * "a connection carries exactly one account's authority and nothing more")
 * — never a caller-supplied external id: LINK-8's own "the account it will
 * attach to is fixed when it is issued" holds by construction, because
 * there is no argument here an assistant's own generated tool-call text
 * could use to name a different one. `organizationId` is the one input this
 * tool does take: which organization's own person the resulting token
 * should be redeemable against, the same "not derivable from the session
 * alone" reasoning `tool-surface.ts`'s own tools already have for the
 * identical field.
 *
 * The token reaches the assistant *only* through this call's own result
 * (LINK-3's "delivered where only that caller can read it" — the same
 * guarantee an MCP tool result already gives the account-bearing catalog
 * above): nothing here posts it to a channel, a page, or a log — `deps.db`
 * is the only thing this function touches besides its own return value.
 *
 * **D-44 rework — deliberately no membership check, but the organization
 * must exist.** A first version minted a token for whatever `organizationId`
 * a model supplied, with no check at all: a foreign but real organization
 * got a valid, redeemable token (the same "no proof required" defect
 * `routes/person-link.ts`'s own module comment describes for the HTTP
 * surface), and a *nonexistent* one threw a raw `better-sqlite3` error —
 * `FOREIGN KEY constraint failed` — straight into the tool result, an
 * internal implementation detail handed to an untrusted client, and a
 * second, cruder tenant-existence oracle than the clean one below. The fix
 * is not `memberships.getMembership` (`call-tool.ts`'s own tenancy check
 * for the dispatch catalog): MCP-3's "exactly one account's authority and
 * nothing more" describes what a *dispatched action* may see, not who may
 * attempt to connect — a student's assistant legitimately requests a token
 * for the student's own institution, an organization the student (and
 * therefore this tool, acting with their authority) has no *membership* in
 * by design, the identical reasoning `routes/person-link.ts`'s own module
 * comment gives for why its HTTP siblings do not gate on membership either.
 * What both surfaces gate on instead is proof, applied at the point that
 * actually matters: minting a token here creates nothing in `people` at
 * all (only a `person_link_challenges` row, swept by its own TTL) — the
 * write `routes/person-link.ts`'s own rework was about deferring happens
 * only once a *human* redeems this token against a matching organization
 * on the panel. Checking existence first (and catching whatever the insert
 * still throws) closes the raw-error leak without adding an oracle worse
 * than the one already accepted for the HTTP surface (an organization id
 * is not a secret, unlike the token this tool actually mints — the same
 * "an id is not a claim" reasoning `routes/person-link.ts`'s own module
 * comment gives for its HTTP siblings, `docs/DECISIONS.md` D-44).
 */
function registerPersonLinkTool(
  mcpServer: McpServer,
  deps: ServerDependencies,
  accountId: string
): void {
  mcpServer.registerTool(
    'bloombot_connectAssistant',
    {
      description:
        'Connect this assistant to your Bloombot account in a given organization. ' +
        'Returns a single-use, short-lived token — hand it to the person you are ' +
        'assisting so they can paste it into the Bloombot panel (Connect an ' +
        'assistant) to finish connecting. Never post this token anywhere else.',
      inputSchema: {
        organizationId: z
          .string()
          .min(1)
          .describe(
            'The organization this token should connect an assistant identity within.'
          ),
      },
    },
    async (args: { organizationId: string }): Promise<CallToolResult> => {
      if (!organizations.getOrganizationById(args.organizationId, deps.db)) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'This organization does not exist or you do not have access to it.',
            },
          ],
        }
      }
      let issued
      try {
        issued = issueMcpPersonLinkToken(
          args.organizationId,
          accountId,
          deps.db
        )
      } catch (error) {
        // Defense in depth against the same raw-driver-error leak this
        // rework closes above — `getOrganizationById` already makes this
        // unreachable in practice, but a thrown, unrecognised error must
        // never reach a client as-is regardless of why.
        deps.logger.error(
          { err: error, organizationId: args.organizationId },
          'apps/mcp: bloombot_connectAssistant failed to issue a token'
        )
        return {
          isError: true,
          content: [
            { type: 'text', text: 'This request could not be completed.' },
          ],
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              token: issued.token,
              expiresAt: issued.expiresAt,
            }),
          },
        ],
      }
    }
  )
}

/** A course this account may ask in, formatted for a comma-separated list in a refusal's own text — never the organization (`tool-surface.ts`'s own `MCP_CHAT_TOOL_SURFACE` module comment on why). */
function describeCourseChoice(choice: {
  courseId: string
  courseTitle: string
  projectName: string
}): string {
  return `${choice.projectName} — ${choice.courseTitle} (courseId: ${choice.courseId})`
}

/**
 * `chat.ask`'s own result, mapped to what an MCP client actually sees.
 * `unlinked` and `needs-course-selection` are `isError: true` — nothing was
 * answered — but deliberately not the generic `describeToolError` text the
 * dispatch catalog's own refusals get: this slice's own brief asks for a
 * *specific* sentence explaining what to do next (ask an instructor; redeem
 * a join link), because a hallucinated or refused `courseId` should
 * self-correct rather than read as an opaque failure. Every other kind
 * (`AnswerResult`'s own — this file's own module comment on `AskChatResult`:
 * "do not silently drop parts of it") is not an error at all, the same
 * ordinary-outcome treatment `routes/chat.ts` already gives every one of
 * them over HTTP (a `200` naming `result.kind`, never a distinct status per
 * kind) — the full result, including the course it answered in, is simply
 * handed back as this tool's own JSON output.
 */
/** Both `chat.listCourses` and `chat.ask` give this exact refusal for an unlinked account (this slice's own brief: "an unlinked session is refused by both tools, naming the connect tool") — a shared constant so the wording literally cannot drift between them. */
const NOT_LINKED_TEXT =
  'This account is not yet connected to a person in any organization, so there is nothing to ask in. ' +
  'Call bloombot_connectAssistant to connect one, and ask the person you are assisting to finish ' +
  'connecting from the Bloombot panel.'

function formatAskChatResult(result: AskChatResult): CallToolResult {
  if (result.kind === 'unlinked') {
    return {
      isError: true,
      content: [{ type: 'text', text: NOT_LINKED_TEXT }],
    }
  }
  if (result.kind === 'needs-course-selection') {
    const list = result.choices.map(describeCourseChoice).join('; ')
    const guidance =
      result.reason === 'none-admitted'
        ? 'This account may not currently ask a question in any course — ask an instructor, or redeem a join link, then try again.'
        : result.reason === 'no-course-id'
          ? `More than one course is available, so I cannot tell which one is meant — ask which, then call chat.ask again naming its courseId. Available: ${list}`
          : `That course could not be found, or this account may not ask in it — ask an instructor, or redeem a join link, then try again. Available: ${list}`
    return {
      isError: true,
      content: [
        { type: 'text', text: guidance },
        { type: 'text', text: JSON.stringify(result.choices) },
      ],
    }
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }] }
}

/**
 * `ServerDependencies.model`'s own fallback when a test (or a caller that
 * genuinely has no need of `chat.ask`) omits it — the identical
 * `createUnconfiguredModelClient` shape `index.ts`'s own module comment
 * describes, duplicated here rather than exported and imported back: this
 * one exists only to satisfy `registerChatTools`' own call, never this
 * process's real, configured client, which `index.ts` always builds and
 * passes through `ServerDependencies` instead.
 */
const UNCONFIGURED_MODEL_CLIENT: ModelClient = {
  ask: () =>
    Promise.reject(new Error('apps/mcp: no ModelClient was configured')),
}

/**
 * MCP-8: `chat.listCourses`/`chat.ask`, registered directly rather than
 * through `registerTools`' own `call-tool.ts` dispatch pipeline —
 * `tool-surface.ts`'s own `MCP_CHAT_TOOL_SURFACE` module comment has the
 * full reasoning for why (the same shape mismatch `registerPersonLinkTool`,
 * just above, already found for LINK-8's own tool). Neither tool is
 * destructive (asking is a read; the enrolment `chat.ask` may create on
 * self-enrolment admission is the same silent, no-confirmation write
 * `routes/chat.ts`'s and Discord's own `handle-mention.ts` already make on
 * the identical signal — MCP-4's own trigger is a *destructive* write, not
 * any write at all, and this slice's own judgement call, recorded in its
 * brief, is that this one does not qualify), so neither needs
 * `requestConfirmation` or `extra` at all.
 */
function registerChatTools(
  mcpServer: McpServer,
  deps: ServerDependencies,
  accountId: string
): void {
  const [listEntry, askEntry] = MCP_CHAT_TOOL_SURFACE
  if (!listEntry || !askEntry) {
    throw new Error(
      'apps/mcp: MCP_CHAT_TOOL_SURFACE is missing one of its two expected entries.'
    )
  }

  mcpServer.registerTool(
    listEntry.name,
    {
      description: listEntry.description,
      inputSchema: listEntry.inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (): Promise<CallToolResult> => {
      try {
        if (!isAccountLinked(accountId, deps.db)) {
          return {
            isError: true,
            content: [{ type: 'text', text: NOT_LINKED_TEXT }],
          }
        }
        const courses = listAskableCourses(accountId, deps.db)
        return { content: [{ type: 'text', text: JSON.stringify(courses) }] }
      } catch (error) {
        // A thrown, unrecognised error — a busy SQLite file under this
        // process's own write contention (`answerQuestion`'s own module
        // comment on `appendMessage`'s `SQLITE_BUSY` retry — a plain read
        // can hit the identical contention) — must never reach a client
        // as-is: the same discipline `registerPersonLinkTool`'s own module
        // comment holds itself to (D-44's "a raw error handed to an
        // untrusted client"). Logged so a failed question is not invisible
        // to this process's own logs, unlike before this fix.
        deps.logger.error(
          { err: error, accountId },
          'apps/mcp: chat.listCourses failed'
        )
        return {
          isError: true,
          content: [
            { type: 'text', text: 'This request could not be completed.' },
          ],
        }
      }
    }
  )

  mcpServer.registerTool(
    askEntry.name,
    {
      description: askEntry.description,
      inputSchema: askEntry.inputSchema,
      // Not read-only (a self-enrolment write can happen on this call), and
      // not destructive either (this function's own doc comment).
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      // The SDK already validated `args` against `askEntry.inputSchema`
      // before this callback ever runs — the same trust `registerTools`
      // above places in its own zod-validated `args` — so this is a plain
      // narrowing, not a second validation pass.
      const input = {
        text: String(args['text']),
        ...(typeof args['courseId'] === 'string'
          ? { courseId: args['courseId'] }
          : {}),
      }
      try {
        const result = await askChatQuestion(accountId, input, {
          db: deps.db,
          model: deps.model ?? UNCONFIGURED_MODEL_CLIENT,
          logger: deps.logger,
          ...(deps.admission ? { admission: deps.admission } : {}),
          ...(deps.pricing ? { pricing: deps.pricing } : {}),
        })
        return formatAskChatResult(result)
      } catch (error) {
        // `answerQuestion` is documented to throw for a `courseId`/
        // `personId`/conversation that does not resolve, or for a write
        // that genuinely fails after retrying (`packages/core/src/answer.ts`'s
        // own module comment names its two existing callers' `.catch` for
        // exactly this) — this tool is the third caller, and needs the
        // identical treatment `registerPersonLinkTool`'s own module comment
        // already gives an unrecognised error: logged, and never handed to
        // the client as-is (a "could not open a conversation for course
        // <uuid> and person <uuid> in organization <uuid>" message would
        // otherwise leak this platform's own internal ids to whatever MCP
        // client is on the other end).
        deps.logger.error(
          { err: error, accountId },
          'apps/mcp: chat.ask failed'
        )
        return {
          isError: true,
          content: [
            { type: 'text', text: 'This request could not be completed.' },
          ],
        }
      }
    }
  )
}

/** Both `chat.listCourses` (MCP-8) and `courses.listAdministered` (MCP-9) give a plain, non-error result for an account that reaches nothing through them — this one is for the latter, worded around membership rather than a connected identity so it does not tell an assistant to reach for `bloombot_connectAssistant`, which grants no *administrative* authority at all. */
const NO_ADMINISTERED_COURSES_TEXT =
  'This account does not hold an administrative membership in any organization, so there is nothing here to list. ' +
  'Ask an owner of the organization you expect to administer to add this account as a member.'

/**
 * MCP-9: `courses.listAdministered`, registered directly rather than
 * through `registerTools`' own `call-tool.ts` dispatch pipeline —
 * `admin-tools.ts`'s own module comment has the full reasoning (the same
 * cross-organization shape mismatch `registerChatTools`, just above,
 * already has for `chat.listCourses`). Read-only and never destructive, so
 * neither `requestConfirmation` nor `extra` is needed here either.
 */
function registerAdminTools(
  mcpServer: McpServer,
  deps: ServerDependencies,
  accountId: string
): void {
  const [entry] = MCP_ADMIN_TOOL_SURFACE
  if (!entry) {
    throw new Error(
      'apps/mcp: MCP_ADMIN_TOOL_SURFACE is missing its one expected entry.'
    )
  }

  mcpServer.registerTool(
    entry.name,
    {
      description: entry.description,
      inputSchema: entry.inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (): Promise<CallToolResult> => {
      try {
        const administered = listAdministeredCourses(accountId, deps.db)
        if (administered.length === 0) {
          return {
            content: [{ type: 'text', text: NO_ADMINISTERED_COURSES_TEXT }],
          }
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(administered) }],
        }
      } catch (error) {
        // A thrown, unrecognised error must never reach a client as-is — the
        // same discipline `registerChatTools`' own `chat.listCourses`
        // handler already holds itself to, just above.
        deps.logger.error(
          { err: error, accountId },
          'apps/mcp: courses.listAdministered failed'
        )
        return {
          isError: true,
          content: [
            { type: 'text', text: 'This request could not be completed.' },
          ],
        }
      }
    }
  )
}

function buildMcpServer(
  deps: ServerDependencies,
  accountId: string
): McpServer {
  const mcpServer = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
  })
  registerTools(mcpServer, deps, accountId)
  registerPersonLinkTool(mcpServer, deps, accountId)
  registerChatTools(mcpServer, deps, accountId)
  registerAdminTools(mcpServer, deps, accountId)
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

  const resourceServerUrl =
    deps.resourceServerUrl ?? new URL('/mcp', deps.issuerUrl)

  // MCP-7 security review — the SDK's own `createOAuthMetadata` hard-codes
  // `token_endpoint_auth_methods_supported: ['client_secret_post', 'none']`
  // and `revocation_endpoint_auth_methods_supported: ['client_secret_post']`,
  // with no option on `mcpAuthRouter` to override either — but this
  // deployment supports only `none` (`schema.ts#mcpOauthClients`'s own
  // module comment: no client secret is ever issued). A strict client that
  // trusts the metadata literally may pick `client_secret_post` and fail to
  // authenticate, or read the (accurate, per-client) `client_secret_expires_at:
  // undefined` as "unsupported" and skip `/revoke` entirely. Mounted
  // *before* `mcpAuthRouter` below, at the exact metadata path, so this
  // corrected document answers first — Express never reaches the SDK's own
  // (still-mounted, for every other path) metadata route for this one.
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    const metadata = createOAuthMetadata({
      provider: deps.oauthProvider,
      issuerUrl: deps.issuerUrl,
    })
    res.status(200).json({
      ...metadata,
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
    })
  })

  // MCP-7 — mounted at this app's own root, the SDK's own required
  // position (`server/auth/router.js`'s own doc comment). Publishes
  // `/authorize`, `/token`, `/register`, `/revoke`,
  // `/.well-known/oauth-authorization-server` (superseded by the corrected
  // route above, for every request that actually reaches it) and
  // `/.well-known/oauth-protected-resource` — every one of them derived
  // from `deps.issuerUrl`/`resourceServerUrl`, never a hard-coded domain
  // (this file's own module comment).
  app.use(
    mcpAuthRouter({
      provider: deps.oauthProvider,
      issuerUrl: deps.issuerUrl,
      resourceServerUrl,
    })
  )

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

/**
 * MCP-7's own two-shape bearer check: an OAuth access token
 * (`deps.oauthProvider.verifyAccessToken`) first — the primary path a real
 * connector uses once `mcpAuthRouter`'s own `/authorize`/`/token` complete
 * — falling back to MCP-3's original session bearer token
 * (`authenticateBearerToken`) when the OAuth verification fails. Never
 * both: a token that verifies as an OAuth access token is never re-checked
 * against `sessions` (this file's own module comment on why the two hash
 * spaces cannot collide regardless), and a token that fails *both* is
 * refused exactly the way an invalid session token always has been —
 * `undefined`, indistinguishable from "wrong" vs. "expired" vs. "revoked",
 * AUTH-3's own guarantee, unchanged by which of the two checks actually
 * ran.
 */
async function resolveCallerAccountId(
  token: string,
  deps: ServerDependencies
): Promise<string | undefined> {
  try {
    const authInfo = await deps.oauthProvider.verifyAccessToken(token)
    const accountId = authInfo.extra?.['accountId']
    if (typeof accountId === 'string') return accountId
  } catch {
    // Not a valid OAuth access token — fall through to the legacy path.
  }
  return authenticateBearerToken(token, deps.db)
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
  const bearerToken = parseBearerToken(req.headers.authorization)
  const accountId = bearerToken
    ? await resolveCallerAccountId(bearerToken, deps)
    : undefined
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
