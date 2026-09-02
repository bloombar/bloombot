/**
 * MCP-4's confirmation, proven over a real MCP connection — a real
 * `@modelcontextprotocol/sdk` `Client`, a real `StreamableHTTPClientTransport`,
 * a real `node:http` server on a real (ephemeral) port, talking to this
 * app's own `buildApp`. `call-tool.test.ts`/`server.test.ts` already prove
 * the dispatch logic and the capability-gate fail-closed path with an
 * injected fake `requestConfirmation`; what neither proves is the full
 * bidirectional round trip — this server sending `elicitation/create`
 * *to* a client mid-`tools/call`, and a human's actual answer (accept,
 * decline, cancel, or no answer at all) actually reaching `call-tool.ts`'s
 * own gate rather than the confirmation being answerable by the model that
 * made the call.
 *
 * A rework finding: two mutations survived the whole suite (36/36 mcp
 * tests, 1426/1426 overall) with only the fake-`requestConfirmation` tests
 * in place — treating any elicitation response as consent, and skipping
 * the `elicitInput` call entirely while still returning `true`. Both are
 * killed here, because both would change what a *real* client — one that
 * actually declines, or actually never answers — sees back from a real
 * `tools/call`.
 *
 * `ELICITATION_TIMEOUT_MS` (`ELICITATION_TIMEOUT_MS` in every test below)
 * is a rework finding of its own: this file used to rely on `server.ts`'s
 * own production default (30s), which is exactly `vitest.config.ts`'s own
 * root `testTimeout` — a genuine hang and a vitest timeout became
 * indistinguishable, both landing at ~30s with no way to tell which end
 * actually stalled. `server.ts#ServerDependencies.elicitationTimeoutMs` is
 * now injectable for exactly this reason; every test here passes a value
 * an order of magnitude below `testTimeout`, so a real hang fails fast and
 * says so, and the whole file runs in a fraction of a second rather than
 * threatening to eat a minute of CI time.
 *
 * Every test builds and disposes its own server, client and database —
 * `setUp`/`ctx.dispose()`, below — entirely inside its own `it(...)`
 * body (`try`/`finally`, not a shared module-level `afterEach`), so one
 * test's own teardown can never be mistaken for bleeding into the next
 * test's timing budget. `dispose()` calls the transport's own
 * `terminateSession()` (a real `DELETE /mcp`) before `client.close()` —
 * `client.close()` alone does *not* send `DELETE` (`docs/DECISIONS.md`
 * D-36's own session-lifecycle finding), so relying on it alone leaves the
 * server-side session semantically "open" (though the socket itself does
 * close) until this file's own server is discarded moments later anyway;
 * terminating it explicitly is the more correct order of operations
 * regardless, and removes one more way a still-registering session could
 * be visible to whatever runs next.
 *
 * The last test in this file (`delayStandaloneGetMs`, `setUp`'s own
 * option) is the actual CI failure this round chased down: an empty
 * `elicitations` array on `cancel` and on the message-naming test (which
 * uses `decline`), in the same CI run, with the other tests in the file
 * passing — a real product bug, not a flaky test. This server used to
 * raise `elicitation/create` through `mcpServer.server.elicitInput(...)`,
 * which sends with no `relatedRequestId` and so lands on the client's
 * *standalone* SSE stream — a stream the SDK client opens lazily,
 * fire-and-forget, only after its own `notifications/initialized` round
 * trip, with nothing that makes `client.connect()` wait for it. A
 * `tools/call` landing before that stream finishes connecting server-side
 * lost its own elicitation silently (`webStandardStreamableHttp.js#send`'s
 * own standalone-stream branch does nothing at all when no stream is
 * registered — no error, no queue), so the server timed out waiting for
 * an answer nobody was ever asked for, and failed closed *as if* declined.
 * Confirmed by direct reproduction (delaying the client's own GET by
 * 300ms against the pre-fix code lost the elicitation on every run) before
 * fixing it, and confirmed fixed the same way — `server.ts`'s own
 * `requestElicitedConfirmation` now sends through `extra.sendRequest`,
 * tied to the `tools/call` that raised it, landing on that call's own
 * already-open response stream instead.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  ElicitRequestSchema,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'
import { createPlatformRegistry } from '@bloombot/actions'
import { courseAttachments, jobs } from '@bloombot/db'
import { describe, expect, it } from 'vitest'

import { buildApp, type ServerDependencies } from '../src/server.js'
import { buildToolDefinitions } from '../src/tool-surface.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'
import { seedAttachment, seedSignedInAccount } from './helpers/seed.js'

/** Well below `vitest.config.ts`'s own 30s `testTimeout` — this file's own module comment on why. Individual tests that specifically exercise the timeout itself pass their own, shorter value still. */
const ELICITATION_TIMEOUT_MS = 2_000

function createFakeLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
  } as unknown as ServerDependencies['logger']
}

/** Starts a real HTTP server on an ephemeral port and hands back its base URL — a real socket, not a `supertest` in-process request, so a real SDK `Client` can talk to it. Binds `127.0.0.1` explicitly, never the wildcard address — a prior slice in this project had a real bug from binding the wildcard in a test. */
function listen(
  deps: ServerDependencies
): Promise<{ url: URL; server: Server }> {
  return new Promise((resolve, reject) => {
    const app = buildApp(deps)
    const server = createServer(app)
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const { port } = server.address() as AddressInfo
      resolve({ url: new URL(`http://127.0.0.1:${port}/mcp`), server })
    })
  })
}

/** How many times this test's own elicitation handler was asked, and what it answers with — set per test. `answer: undefined` never resolves at all — this file's own timeout test. */
function buildTestClient(answer: (() => ElicitResult) | undefined): {
  client: Client
  elicitations: { message: string }[]
} {
  const client = new Client(
    { name: 'apps/mcp e2e test client', version: '0.0.0' },
    // `form: {}` — a real capability declaration, not the empty
    // `elicitation: {}` shorthand `getSupportedElicitationModes`'s own doc
    // comment says a *client* is free to interpret as form support: the
    // server (`requestElicitedConfirmation`, `server.ts`) reads
    // `_clientCapabilities` exactly as the client sent it, with no such
    // normalization — this declares the capability the server's own gate
    // literally checks for.
    { capabilities: { elicitation: { form: {} } } }
  )
  const elicitations: { message: string }[] = []
  client.setRequestHandler(ElicitRequestSchema, (request) => {
    elicitations.push({ message: request.params.message })
    // A handler that never settles at all — this file's own timeout test —
    // rather than one more `Promise.resolve(...)` racing the server's own
    // timeout from the client side too.
    return answer
      ? Promise.resolve(answer())
      : new Promise<ElicitResult>(() => {})
  })
  return { client, elicitations }
}

interface TestContext {
  testDb: TestDatabase
  caller: ReturnType<typeof seedSignedInAccount>
  attachmentId: string
  server: Server
  client: Client
  elicitations: { message: string }[]
  dispose: () => Promise<void>
}

/**
 * Builds one complete, isolated scenario — database, seeded account and
 * attachment, a real listening server, a real connected client — and a
 * `dispose()` that tears every one of them down. Every `it(...)` below
 * calls this once, uses the result, and disposes it in its own `finally`,
 * so no two tests ever share a server, a client, a port or a database
 * connection (this file's own module comment on why that matters more
 * than it might look like it should).
 */
async function setUp(options: {
  answer: (() => ElicitResult) | undefined
  elicitationTimeoutMs?: number
  /**
   * Delays the client's own standalone `GET /mcp` stream (the one it opens
   * fire-and-forget, after `notifications/initialized`, to receive
   * unsolicited server pushes) by this many milliseconds — this file's own
   * regression test for the race `requestElicitedConfirmation`'s own
   * module comment (`server.ts`) describes: an `elicitation/create` raised
   * during a `tools/call` must reach the client over that call's own POST
   * response stream, never depending on this GET having connected yet.
   * Patches `globalThis.fetch` for the duration of the scenario, restored
   * in `dispose()`.
   */
  delayStandaloneGetMs?: number
}): Promise<TestContext> {
  const testDb = createTestDatabase()
  const caller = seedSignedInAccount(testDb.db)
  const attachmentId = seedAttachment(testDb.db, caller.organizationId)
  const registry = createPlatformRegistry()

  const listening = await listen({
    db: testDb.db,
    logger: createFakeLogger(),
    toolDefinitions: buildToolDefinitions(registry),
    elicitationTimeoutMs:
      options.elicitationTimeoutMs ?? ELICITATION_TIMEOUT_MS,
  })

  const realFetch = globalThis.fetch
  if (options.delayStandaloneGetMs) {
    const delayMs = options.delayStandaloneGetMs
    const mcpUrl = listening.url.toString()
    globalThis.fetch = (async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const href =
        typeof input === 'string'
          ? input
          : ((input as { url?: string }).url ?? String(input))
      if (method === 'GET' && href === mcpUrl) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      return realFetch(input, init)
    }) as typeof fetch
  }

  const built = buildTestClient(options.answer)
  const transport = new StreamableHTTPClientTransport(listening.url, {
    requestInit: { headers: { Authorization: `Bearer ${caller.token}` } },
  })
  // The SDK's own `StreamableHTTPClientTransport` declares `implements
  // Transport`, but under this `tsconfig.base.json`'s own
  // `exactOptionalPropertyTypes` its accessor-typed `onclose`/`onerror`/
  // `onmessage` members are structurally incompatible with `Transport`'s
  // plain optional ones — the same friction `server.ts`'s own module
  // comment documents for the server-side transport, applying here to the
  // client-side one too.
  await built.client.connect(
    transport as unknown as Parameters<typeof built.client.connect>[0]
  )

  const dispose = async (): Promise<void> => {
    // Each step tried independently: a failure terminating the session (the
    // server may already be gone, or may have never granted one) must not
    // skip closing the client or the server, and a failure closing one of
    // those must not skip the others — every resource this scenario opened
    // gets a real attempt at closing, not just the first one that happens
    // to succeed.
    globalThis.fetch = realFetch
    await transport.terminateSession().catch(() => undefined)
    await built.client.close().catch(() => undefined)
    await new Promise<void>((resolve) =>
      listening.server.close(() => resolve())
    )
    testDb.cleanup()
  }

  return {
    testDb,
    caller,
    attachmentId,
    server: listening.server,
    client: built.client,
    elicitations: built.elicitations,
    dispose,
  }
}

describe('MCP-4 over a real connection — courseAttachments.detach', () => {
  it('accept {confirm:true} — dispatches, one elicitation, the attachment is detached', async () => {
    const ctx = await setUp({
      answer: () => ({ action: 'accept', content: { confirm: true } }),
    })
    try {
      const result = await ctx.client.callTool({
        name: 'courseAttachments.detach',
        arguments: {
          organizationId: ctx.caller.organizationId,
          attachmentId: ctx.attachmentId,
        },
      })

      expect(ctx.elicitations).toHaveLength(1)
      expect(result.isError).toBeFalsy()
      const content = result.content as { type: string; text: string }[]
      expect(JSON.parse(content[0]?.text ?? 'null')).toMatchObject({
        jobId: expect.any(String),
      })
      expect(jobs.countQueuedJobs(ctx.testDb.db)).toBe(1)
    } finally {
      await ctx.dispose()
    }
  })

  it('accept {confirm:false} — refused, "was not confirmed", nothing dispatched', async () => {
    const ctx = await setUp({
      answer: () => ({ action: 'accept', content: { confirm: false } }),
    })
    try {
      const result = await ctx.client.callTool({
        name: 'courseAttachments.detach',
        arguments: {
          organizationId: ctx.caller.organizationId,
          attachmentId: ctx.attachmentId,
        },
      })

      expect(ctx.elicitations).toHaveLength(1)
      expect(result.isError).toBe(true)
      const content = result.content as { type: string; text: string }[]
      expect(content[0]?.text).toMatch(/was not confirmed/)
      expect(
        courseAttachments.getAttachment(
          ctx.caller.organizationId,
          ctx.attachmentId,
          ctx.testDb.db
        )?.status
      ).toBe('pending')
      expect(jobs.countQueuedJobs(ctx.testDb.db)).toBe(0)
    } finally {
      await ctx.dispose()
    }
  })

  it('decline — refused, "was not confirmed", nothing dispatched', async () => {
    const ctx = await setUp({ answer: () => ({ action: 'decline' }) })
    try {
      const result = await ctx.client.callTool({
        name: 'courseAttachments.detach',
        arguments: {
          organizationId: ctx.caller.organizationId,
          attachmentId: ctx.attachmentId,
        },
      })

      expect(ctx.elicitations).toHaveLength(1)
      expect(result.isError).toBe(true)
      const content = result.content as { type: string; text: string }[]
      expect(content[0]?.text).toMatch(/was not confirmed/)
      expect(jobs.countQueuedJobs(ctx.testDb.db)).toBe(0)
    } finally {
      await ctx.dispose()
    }
  })

  it('cancel — refused, "was not confirmed", nothing dispatched', async () => {
    const ctx = await setUp({ answer: () => ({ action: 'cancel' }) })
    try {
      const result = await ctx.client.callTool({
        name: 'courseAttachments.detach',
        arguments: {
          organizationId: ctx.caller.organizationId,
          attachmentId: ctx.attachmentId,
        },
      })

      expect(ctx.elicitations).toHaveLength(1)
      expect(result.isError).toBe(true)
      const content = result.content as { type: string; text: string }[]
      expect(content[0]?.text).toMatch(/was not confirmed/)
      expect(jobs.countQueuedJobs(ctx.testDb.db)).toBe(0)
    } finally {
      await ctx.dispose()
    }
  })

  it("no answer at all — the server's own elicitInput times out, fails closed exactly like an explicit decline, nothing dispatched", async () => {
    // A short, dedicated timeout (not the file's own `ELICITATION_TIMEOUT_MS`)
    // — this test's whole point is waiting the timeout out, so it gets the
    // smallest one that still gives the round trip room to actually happen.
    const ctx = await setUp({ answer: undefined, elicitationTimeoutMs: 300 })
    try {
      const result = await ctx.client.callTool({
        name: 'courseAttachments.detach',
        arguments: {
          organizationId: ctx.caller.organizationId,
          attachmentId: ctx.attachmentId,
        },
      })

      expect(ctx.elicitations).toHaveLength(1)
      expect(result.isError).toBe(true)
      const content = result.content as { type: string; text: string }[]
      expect(content[0]?.text).toMatch(/was not confirmed/)
      expect(
        courseAttachments.getAttachment(
          ctx.caller.organizationId,
          ctx.attachmentId,
          ctx.testDb.db
        )?.status
      ).toBe('pending')
      expect(jobs.countQueuedJobs(ctx.testDb.db)).toBe(0)
    } finally {
      await ctx.dispose()
    }
  })

  it('the elicitation message names the specific attachment, not just the tool and a raw organization id', async () => {
    const ctx = await setUp({ answer: () => ({ action: 'decline' }) })
    try {
      await ctx.client.callTool({
        name: 'courseAttachments.detach',
        arguments: {
          organizationId: ctx.caller.organizationId,
          attachmentId: ctx.attachmentId,
        },
      })

      expect(ctx.elicitations[0]?.message).toContain('notes.pdf')
    } finally {
      await ctx.dispose()
    }
  })

  it("the confirmation reaches the client even when its own standalone GET stream has not connected yet — a CI-only failure reproduced by delaying it, fixed by sending elicitation/create on the tools/call's own response stream rather than the standalone one", async () => {
    // This delay (300ms) reliably reproduced an empty `elicitations` array
    // against the pre-fix code that called `mcpServer.server.elicitInput(...)`
    // directly (no `relatedRequestId`, so the message went out on the
    // standalone stream, which had not registered server-side yet) — see
    // `requestElicitedConfirmation`'s own module comment (`server.ts`) for
    // the mechanism. Against the fix (`extra.sendRequest`, tied to the
    // `tools/call` that raised it), this passes regardless of the delay —
    // proven directly during this fix's own development at 5 full seconds,
    // an order of magnitude past what any real network hiccup would need.
    const ctx = await setUp({
      answer: () => ({ action: 'accept', content: { confirm: true } }),
      delayStandaloneGetMs: 300,
    })
    try {
      const result = await ctx.client.callTool({
        name: 'courseAttachments.detach',
        arguments: {
          organizationId: ctx.caller.organizationId,
          attachmentId: ctx.attachmentId,
        },
      })

      expect(ctx.elicitations).toHaveLength(1)
      expect(result.isError).toBeFalsy()
      expect(jobs.countQueuedJobs(ctx.testDb.db)).toBe(1)
    } finally {
      await ctx.dispose()
    }
  })
})
