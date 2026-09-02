/**
 * `server.ts`'s own job: wiring `call-tool.ts`/`tool-surface.ts` to a real
 * HTTP request and session lifecycle. `call-tool.test.ts`/`tool-surface.test.ts`
 * already cover the dispatch logic itself in detail; this file proves the
 * transport actually carries it — authentication happens before a tool
 * runs (MCP-3), an MCP session is pinned to the account that created it,
 * the allowlisted tools are reachable over `/mcp`, and a refusal from
 * `call-tool.ts` reaches the client as an `isError` tool result rather
 * than an unhandled exception.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { createPlatformRegistry } from '@bloombot/actions'
import { closeDatabase, openDatabase, runMigrations } from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import { buildApp, type ServerDependencies } from '../src/server.js'
import {
  initializeMcpSession,
  sendMcpRequest,
  type JsonRpcMessage,
} from './helpers/mcp-http-client.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'
import {
  seedAttachment,
  seedOtherOrganization,
  seedSignedInAccount,
} from './helpers/seed.js'

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

function buildTestApp(
  overrides: Partial<ServerDependencies> & { db: ServerDependencies['db'] }
) {
  return buildApp({
    logger: createFakeLogger(),
    registry: createPlatformRegistry(),
    ...overrides,
  })
}

function findMessage(
  messages: JsonRpcMessage[],
  id: number
): JsonRpcMessage | undefined {
  return messages.find((message) => message.id === id)
}

let testDb: TestDatabase | undefined

afterEach(() => {
  testDb?.cleanup()
  testDb = undefined
})

describe('the health endpoint', () => {
  it('reports ready when the database is reachable', async () => {
    testDb = createTestDatabase()
    const app = buildTestApp({ db: testDb.db })

    const response = await request(app).get('/health')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ ready: true, database: true })
  })

  it('reports not-ready (503) when the database is unreachable', async () => {
    const tmpRoot = join(process.cwd(), 'tmp', 'mcp-tests')
    mkdirSync(tmpRoot, { recursive: true })
    const path = join(tmpRoot, `${randomUUID()}.db`)
    const db = openDatabase(path)
    runMigrations(db)
    const app = buildTestApp({ db })
    closeDatabase(db)

    const response = await request(app).get('/health')

    expect(response.status).toBe(503)
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${path}${suffix}`, { force: true })
    }
  })
})

describe('MCP-3 — authentication happens before a tool ever runs', () => {
  it('refuses to even start a session with no Authorization header at all', async () => {
    testDb = createTestDatabase()
    const app = buildTestApp({ db: testDb.db })

    await expect(initializeMcpSession(app, '')).rejects.toThrow()
  })

  it('refuses to start a session with a bearer token that does not validate', async () => {
    testDb = createTestDatabase()
    const app = buildTestApp({ db: testDb.db })

    await expect(
      initializeMcpSession(app, 'not-a-real-token')
    ).rejects.toThrow()
  })

  it('refuses a later request in an existing session once its bearer token stops validating', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const app = buildTestApp({ db: testDb.db })
    const session = await initializeMcpSession(app, caller.token)

    const response = await sendMcpRequest(app, session, 'not-a-real-token', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    })

    expect(response.status).toBe(401)
  })

  it("refuses a second account's bearer token reused against a session that is not its own", async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const otherCaller = seedSignedInAccount(testDb.db)
    const app = buildTestApp({ db: testDb.db })
    const session = await initializeMcpSession(app, caller.token)

    const response = await sendMcpRequest(app, session, otherCaller.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    })

    expect(response.status).toBe(401)
  })

  it('refuses GET/DELETE against a session id nothing has ever heard of', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const app = buildTestApp({ db: testDb.db })

    const get = await request(app)
      .get('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Authorization', `Bearer ${caller.token}`)
      .set('Mcp-Session-Id', 'session-nothing-knows-about')
    expect(get.status).toBe(404)

    const del = await request(app)
      .delete('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .set('Authorization', `Bearer ${caller.token}`)
      .set('Mcp-Session-Id', 'session-nothing-knows-about')
    expect(del.status).toBe(404)
  })
})

describe('the /mcp endpoint end to end, once authenticated', () => {
  it('lists the allow-listed tools, each requiring organizationId', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const app = buildTestApp({ db: testDb.db })
    const session = await initializeMcpSession(app, caller.token)

    const response = await sendMcpRequest(app, session, caller.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    })

    expect(response.status).toBe(200)
    const listResult = findMessage(response.messages, 1)?.result as {
      tools: { name: string; inputSchema: { required?: string[] } }[]
    }
    const names = listResult.tools.map((tool) => tool.name)
    expect(names).toContain('projects.list')
    // Not `discordServers.remove` or any other real-but-unlisted action —
    // MCP-2, from the transport side this time.
    expect(names).not.toContain('discordServers.remove')
    const projectsList = listResult.tools.find(
      (tool) => tool.name === 'projects.list'
    )
    expect(projectsList?.inputSchema.required).toContain('organizationId')
  })

  it('calls an allow-listed tool and returns its dispatched result', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const app = buildTestApp({ db: testDb.db })
    const session = await initializeMcpSession(app, caller.token)

    const response = await sendMcpRequest(app, session, caller.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'projects.list',
        arguments: { organizationId: caller.organizationId },
      },
    })

    const callResult = findMessage(response.messages, 1)?.result as {
      isError?: boolean
      content: { type: string; text: string }[]
    }
    expect(callResult.isError).toBeFalsy()
    expect(JSON.parse(callResult.content[0]?.text ?? 'null')).toEqual([])
  })

  it('refuses, as an isError tool result, a call against an organization the caller does not belong to (MCP-3)', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const otherOrganizationId = seedOtherOrganization(testDb.db)
    const app = buildTestApp({ db: testDb.db })
    const session = await initializeMcpSession(app, caller.token)

    const response = await sendMcpRequest(app, session, caller.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'projects.list',
        arguments: { organizationId: otherOrganizationId },
      },
    })

    const callResult = findMessage(response.messages, 1)?.result as {
      isError?: boolean
      content: { type: string; text: string }[]
    }
    expect(callResult.isError).toBe(true)
    expect(callResult.content[0]?.text).toMatch(
      /does not exist or you do not have access to it/
    )
  })

  it('returns an isError result for a tool name not on the allowlist', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const app = buildTestApp({ db: testDb.db })
    const session = await initializeMcpSession(app, caller.token)

    const response = await sendMcpRequest(app, session, caller.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'discordServers.remove',
        arguments: { organizationId: caller.organizationId, serverId: 'x' },
      },
    })

    const callResult = findMessage(response.messages, 1)?.result as {
      isError?: boolean
    }
    expect(callResult?.isError).toBe(true)
  })

  it('MCP-4: refuses a destructive tool, as an isError result, when the connected client never declared elicitation support', async () => {
    // `initializeMcpSession`'s own `capabilities: {}` (mcp-http-client.ts)
    // declares no `elicitation` capability at all — the ordinary case for a
    // client that has never implemented it. `requestElicitedConfirmation`
    // (server.ts) fails this closed rather than silently skipping the
    // confirmation and running the destructive tool anyway.
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const attachmentId = seedAttachment(testDb.db, caller.organizationId)
    const app = buildTestApp({ db: testDb.db })
    const session = await initializeMcpSession(app, caller.token)

    const response = await sendMcpRequest(app, session, caller.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'courseAttachments.detach',
        arguments: { organizationId: caller.organizationId, attachmentId },
      },
    })

    const callResult = findMessage(response.messages, 1)?.result as {
      isError?: boolean
      content: { type: string; text: string }[]
    }
    expect(callResult.isError).toBe(true)
    expect(callResult.content[0]?.text).toMatch(/was not confirmed/)
  })
})
