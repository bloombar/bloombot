/**
 * MCP-4's confirmation, proven over a real MCP connection — a real
 * `@modelcontextprotocol/sdk` `Client`, a real `StreamableHTTPClientTransport`,
 * a real `node:http` server on a real (ephemeral) port, talking to this
 * app's own `buildApp`. `call-tool.test.ts`/`server.test.ts` already prove
 * the dispatch logic and the capability-gate fail-closed path with an
 * injected fake `requestConfirmation`; what neither proves is the full
 * bidirectional round trip — this server sending `elicitation/create`
 * *to* a client mid-`tools/call`, and a human's actual answer (accept,
 * decline, or cancel) actually reaching `call-tool.ts`'s own gate rather
 * than the confirmation being answerable by the model that made the call.
 *
 * A rework finding: two mutations survived the whole suite (36/36 mcp
 * tests, 1426/1426 overall) with only the fake-`requestConfirmation` tests
 * in place — treating any elicitation response as consent, and skipping
 * the `elicitInput` call entirely while still returning `true`. Both are
 * killed here, because both would change what a *real* client — one that
 * actually declines, or actually never answers — sees back from a real
 * `tools/call`.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  ElicitRequestSchema,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'
import { courseAttachments, jobs } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'

import { buildApp, type ServerDependencies } from '../src/server.js'
import { buildToolDefinitions } from '../src/tool-surface.js'
import { createPlatformRegistry } from '@bloombot/actions'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'
import { seedAttachment, seedSignedInAccount } from './helpers/seed.js'

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

/** Starts a real HTTP server on an ephemeral port and hands back its base URL — a real socket, not a `supertest` in-process request, so a real SDK `Client` can talk to it. */
async function listen(deps: ServerDependencies): Promise<{
  url: URL
  server: Server
}> {
  const app = buildApp(deps)
  const server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: new URL(`http://127.0.0.1:${port}/mcp`), server }
}

/** How many times this test's own elicitation handler was asked, and what it answers with — set per test. */
function buildTestClient(elicitationAnswer: () => ElicitResult): {
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
    return Promise.resolve(elicitationAnswer())
  })
  return { client, elicitations }
}

let testDb: TestDatabase | undefined
let server: Server | undefined
let client: Client | undefined

afterEach(async () => {
  await client?.close()
  client = undefined
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = undefined
  testDb?.cleanup()
  testDb = undefined
})

/** Connects `client` to `url` with `token` as its bearer credential — the SDK's own `implements Transport` structural friction under `exactOptionalPropertyTypes` (`server.ts`'s own module comment has the full reasoning) applies to the client transport too. */
async function connect(
  testClient: Client,
  url: URL,
  token: string
): Promise<void> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await testClient.connect(
    transport as unknown as Parameters<typeof testClient.connect>[0]
  )
}

describe('MCP-4 over a real connection — courseAttachments.detach', () => {
  it('accept {confirm:true} — dispatches, one elicitation, the attachment is detached', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const attachmentId = seedAttachment(testDb.db, caller.organizationId)
    const registry = createPlatformRegistry()
    const listening = await listen({
      db: testDb.db,
      logger: createFakeLogger(),
      toolDefinitions: buildToolDefinitions(registry),
    })
    server = listening.server

    const built = buildTestClient(() => ({
      action: 'accept',
      content: { confirm: true },
    }))
    client = built.client
    await connect(client, listening.url, caller.token)

    const result = await client.callTool({
      name: 'courseAttachments.detach',
      arguments: { organizationId: caller.organizationId, attachmentId },
    })

    expect(built.elicitations).toHaveLength(1)
    expect(result.isError).toBeFalsy()
    const content = result.content as { type: string; text: string }[]
    expect(JSON.parse(content[0]?.text ?? 'null')).toMatchObject({
      jobId: expect.any(String),
    })
    expect(jobs.countQueuedJobs(testDb.db)).toBe(1)
  })

  it('accept {confirm:false} — refused, "was not confirmed", nothing dispatched', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const attachmentId = seedAttachment(testDb.db, caller.organizationId)
    const registry = createPlatformRegistry()
    const listening = await listen({
      db: testDb.db,
      logger: createFakeLogger(),
      toolDefinitions: buildToolDefinitions(registry),
    })
    server = listening.server

    const built = buildTestClient(() => ({
      action: 'accept',
      content: { confirm: false },
    }))
    client = built.client
    await connect(client, listening.url, caller.token)

    const result = await client.callTool({
      name: 'courseAttachments.detach',
      arguments: { organizationId: caller.organizationId, attachmentId },
    })

    expect(built.elicitations).toHaveLength(1)
    expect(result.isError).toBe(true)
    const content = result.content as { type: string; text: string }[]
    expect(content[0]?.text).toMatch(/was not confirmed/)
    expect(
      courseAttachments.getAttachment(
        caller.organizationId,
        attachmentId,
        testDb.db
      )?.status
    ).toBe('pending')
    expect(jobs.countQueuedJobs(testDb.db)).toBe(0)
  })

  it('decline — refused, "was not confirmed", nothing dispatched', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const attachmentId = seedAttachment(testDb.db, caller.organizationId)
    const registry = createPlatformRegistry()
    const listening = await listen({
      db: testDb.db,
      logger: createFakeLogger(),
      toolDefinitions: buildToolDefinitions(registry),
    })
    server = listening.server

    const built = buildTestClient(() => ({ action: 'decline' }))
    client = built.client
    await connect(client, listening.url, caller.token)

    const result = await client.callTool({
      name: 'courseAttachments.detach',
      arguments: { organizationId: caller.organizationId, attachmentId },
    })

    expect(built.elicitations).toHaveLength(1)
    expect(result.isError).toBe(true)
    const content = result.content as { type: string; text: string }[]
    expect(content[0]?.text).toMatch(/was not confirmed/)
    expect(jobs.countQueuedJobs(testDb.db)).toBe(0)
  })

  it('cancel — refused, "was not confirmed", nothing dispatched', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const attachmentId = seedAttachment(testDb.db, caller.organizationId)
    const registry = createPlatformRegistry()
    const listening = await listen({
      db: testDb.db,
      logger: createFakeLogger(),
      toolDefinitions: buildToolDefinitions(registry),
    })
    server = listening.server

    const built = buildTestClient(() => ({ action: 'cancel' }))
    client = built.client
    await connect(client, listening.url, caller.token)

    const result = await client.callTool({
      name: 'courseAttachments.detach',
      arguments: { organizationId: caller.organizationId, attachmentId },
    })

    expect(built.elicitations).toHaveLength(1)
    expect(result.isError).toBe(true)
    const content = result.content as { type: string; text: string }[]
    expect(content[0]?.text).toMatch(/was not confirmed/)
    expect(jobs.countQueuedJobs(testDb.db)).toBe(0)
  })

  it('the elicitation message names the specific attachment, not just the tool and a raw organization id', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const attachmentId = seedAttachment(testDb.db, caller.organizationId)
    const registry = createPlatformRegistry()
    const listening = await listen({
      db: testDb.db,
      logger: createFakeLogger(),
      toolDefinitions: buildToolDefinitions(registry),
    })
    server = listening.server

    const built = buildTestClient(() => ({ action: 'decline' }))
    client = built.client
    await connect(client, listening.url, caller.token)

    await client.callTool({
      name: 'courseAttachments.detach',
      arguments: { organizationId: caller.organizationId, attachmentId },
    })

    expect(built.elicitations[0]?.message).toContain('notes.pdf')
  })
})
