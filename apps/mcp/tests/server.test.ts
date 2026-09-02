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
import {
  closeDatabase,
  openDatabase,
  organizations,
  runMigrations,
} from '@bloombot/db'
import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import {
  buildApp,
  MAX_SESSIONS_PER_ACCOUNT,
  sweepIdleSessions,
  type McpSession,
  type ServerDependencies,
} from '../src/server.js'
import { buildToolDefinitions } from '../src/tool-surface.js'
import {
  closeMcpSession,
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
  overrides: Partial<ServerDependencies> & { db: ServerDependencies['db'] },
  sessions?: Map<string, McpSession>,
  isShuttingDown?: () => boolean
) {
  const deps: ServerDependencies = {
    logger: createFakeLogger(),
    toolDefinitions: buildToolDefinitions(createPlatformRegistry()),
    ...overrides,
  }
  return buildApp(deps, sessions, isShuttingDown)
}

/** A fake `StreamableHTTPServerTransport` — just enough surface for `sweepIdleSessions` to exercise (`.close()`), with no real SDK object or HTTP request involved at all. */
function fakeTransport() {
  let closed = false
  return {
    close: () => {
      closed = true
      return Promise.resolve()
    },
    get closed() {
      return closed
    },
  }
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
    expect(response.body).toMatchObject({
      ready: true,
      database: true,
      sessions: 0,
    })
  })

  it('reports how many MCP sessions are currently open — visibility this rework round added after a live listener found unbounded growth with no way to see it', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const app = buildTestApp({ db: testDb.db })

    await initializeMcpSession(app, caller.token)
    const response = await request(app).get('/health')

    expect(response.body).toMatchObject({ sessions: 1 })
  })

  it('reports not-ready (503) once shutdown has begun, even though the database is still reachable — a rework finding: this used to keep reporting ready: true for the whole teardown window', async () => {
    testDb = createTestDatabase()
    const app = buildTestApp({ db: testDb.db }, undefined, () => true)

    const response = await request(app).get('/health')

    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({ ready: false, database: true })
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

describe('bloombot_connectAssistant (LINK-8)', () => {
  it('is on the tool list, not gated behind organizationId the same way the dispatch catalog is (it takes its own)', async () => {
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

    const listResult = findMessage(response.messages, 1)?.result as {
      tools: { name: string; inputSchema: { required?: string[] } }[]
    }
    const tool = listResult.tools.find(
      (candidate) => candidate.name === 'bloombot_connectAssistant'
    )
    expect(tool).toBeDefined()
    expect(tool?.inputSchema.required).toContain('organizationId')
  })

  it('returns a token in the tool result, redeemable to connect the calling account as an mcp identity', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const app = buildTestApp({ db: testDb.db })
    const session = await initializeMcpSession(app, caller.token)

    const response = await sendMcpRequest(app, session, caller.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'bloombot_connectAssistant',
        arguments: { organizationId: caller.organizationId },
      },
    })

    const callResult = findMessage(response.messages, 1)?.result as {
      isError?: boolean
      content: { type: string; text: string }[]
    }
    expect(callResult.isError).toBeFalsy()
    const body = JSON.parse(callResult.content[0]?.text ?? 'null') as {
      token: string
      expiresAt: number
    }
    expect(body.token.length).toBeGreaterThan(20)
    expect(body.expiresAt).toBeGreaterThan(Date.now())

    // The token this call minted actually redeems — LINK-3's own proof —
    // and it is bound to the *calling account*, never a value this call's
    // own arguments named (there is no argument for one at all: LINK-8's
    // "the account it will attach to is fixed when it is issued").
    const { previewMcpPersonLink } = await import('@bloombot/auth')
    const { people } = await import('@bloombot/db')
    const survivor = people.createPerson(caller.organizationId, {}, testDb.db)
    const preview = previewMcpPersonLink(body.token, survivor.id, testDb.db)
    expect(preview?.identity).toEqual({
      surface: 'mcp',
      externalId: caller.accountId,
    })
  })

  it('two calls for the same account and organization mint two independent, single-use tokens', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const app = buildTestApp({ db: testDb.db })
    const session = await initializeMcpSession(app, caller.token)

    const first = await sendMcpRequest(app, session, caller.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'bloombot_connectAssistant',
        arguments: { organizationId: caller.organizationId },
      },
    })
    const second = await sendMcpRequest(app, session, caller.token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'bloombot_connectAssistant',
        arguments: { organizationId: caller.organizationId },
      },
    })

    const firstToken = (
      JSON.parse(
        (
          findMessage(first.messages, 1)?.result as {
            content: { text: string }[]
          }
        ).content[0]?.text ?? 'null'
      ) as { token: string }
    ).token
    const secondToken = (
      JSON.parse(
        (
          findMessage(second.messages, 2)?.result as {
            content: { text: string }[]
          }
        ).content[0]?.text ?? 'null'
      ) as { token: string }
    ).token
    expect(firstToken).not.toBe(secondToken)
  })

  // D-44 rework — a reviewer's own reproduction: no existence check at all
  // meant a nonexistent organization threw `better-sqlite3`'s own
  // `FOREIGN KEY constraint failed` straight into the tool result.
  it('refuses cleanly for a nonexistent organization, never leaking a raw driver error', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const app = buildTestApp({ db: testDb.db })
    const session = await initializeMcpSession(app, caller.token)

    const response = await sendMcpRequest(app, session, caller.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'bloombot_connectAssistant',
        arguments: { organizationId: randomUUID() },
      },
    })

    const callResult = findMessage(response.messages, 1)?.result as {
      isError?: boolean
      content: { type: string; text: string }[]
    }
    expect(callResult.isError).toBe(true)
    expect(callResult.content[0]?.text).not.toMatch(/FOREIGN KEY|SQLITE/i)
    expect(callResult.content[0]?.text).toMatch(
      /does not exist or you do not have access/
    )
  })

  // D-44 rework — deliberately no membership check (this file's own doc
  // comment on why: an assistant legitimately requests a token for the
  // caller's own institution, which the caller has no *membership* in by
  // design), proven directly: a real organization the caller does not
  // belong to still mints a token.
  it('mints a token for a real organization the caller has no membership in — by design, not an oversight', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const foreignOrganizationId = randomUUID()
    organizations.createOrganization(
      foreignOrganizationId,
      { name: 'A Different Institution', isPersonal: false },
      testDb.db
    )
    const app = buildTestApp({ db: testDb.db })
    const session = await initializeMcpSession(app, caller.token)

    const response = await sendMcpRequest(app, session, caller.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'bloombot_connectAssistant',
        arguments: { organizationId: foreignOrganizationId },
      },
    })

    const callResult = findMessage(response.messages, 1)?.result as {
      isError?: boolean
      content: { type: string; text: string }[]
    }
    expect(callResult.isError).toBeFalsy()
    const body = JSON.parse(callResult.content[0]?.text ?? 'null') as {
      token: string
    }
    expect(body.token.length).toBeGreaterThan(20)
  })
})

describe('session lifecycle — bounded growth (rework finding: a live listener measured unbounded retention with no cap and no reclaim)', () => {
  it('closes the session and evicts it from the map when the client sends DELETE /mcp — the same session id then reads as unknown', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const app = buildTestApp({ db: testDb.db })
    const session = await initializeMcpSession(app, caller.token)

    expect((await request(app).get('/health')).body).toMatchObject({
      sessions: 1,
    })

    const deleteStatus = await closeMcpSession(app, session, caller.token)
    expect(deleteStatus).toBe(200)

    // `onclose`/`onsessionclosed` (server.ts) both delete the map entry —
    // this is the observable effect: a session id that used to work is now
    // "session not found", and `/health` no longer counts it.
    expect((await request(app).get('/health')).body).toMatchObject({
      sessions: 0,
    })
    const reused = await sendMcpRequest(app, session, caller.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    })
    expect(reused.status).toBe(404)
  })

  it('evicts the map entry when the transport itself closes for a reason other than a client DELETE — the SDK-level onclose hook, not only onsessionclosed', async () => {
    // `onsessionclosed` (server.ts) only fires for a client-driven DELETE —
    // the test above already proves that path. This proves the other one:
    // the transport's own `onclose` fires whenever *it* considers the
    // session over (an abrupt disconnect this process cannot drive from an
    // HTTP client in a test, or — the actual production caller —
    // `sweepIdleSessions` closing an idle transport itself). Reaches the
    // injected `sessions` map directly (`buildApp`'s own second, optional
    // parameter) to call `.close()` on the real transport `server.ts`
    // built, the same way `sweepIdleSessions` does, without going through
    // `DELETE /mcp` at all.
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const sessions = new Map<string, McpSession>()
    const app = buildTestApp({ db: testDb.db }, sessions)
    await initializeMcpSession(app, caller.token)

    expect(sessions.size).toBe(1)
    const [session] = [...sessions.values()]
    await session?.transport.close()

    expect(sessions.size).toBe(0)
  })

  it("evicts the account's own oldest session — never refuses — once a new one would put it over MAX_SESSIONS_PER_ACCOUNT", async () => {
    // Rework finding: an earlier version refused the new session (429)
    // instead. `StreamableHTTPClientTransport#close()` — what an ordinary
    // client calls on a normal disconnect — does not send `DELETE`, so a
    // restarted assistant's old session stays in the map until the idle
    // sweep eventually reaps it; refusing a legitimate reconnect inside
    // that window punished ordinary use. Eviction means a new session
    // always succeeds, at the cost of the account's own least-recently-used
    // one — never a refusal, and never another account's session.
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const app = buildTestApp({ db: testDb.db })

    const oldestSession = await initializeMcpSession(app, caller.token)
    for (let i = 1; i < MAX_SESSIONS_PER_ACCOUNT; i++) {
      await initializeMcpSession(app, caller.token)
    }
    expect((await request(app).get('/health')).body).toMatchObject({
      sessions: MAX_SESSIONS_PER_ACCOUNT,
    })

    // One more — succeeds, not refused, and the total does not grow past
    // the cap.
    await expect(
      initializeMcpSession(app, caller.token)
    ).resolves.toMatchObject({ sessionId: expect.any(String) })
    expect((await request(app).get('/health')).body).toMatchObject({
      sessions: MAX_SESSIONS_PER_ACCOUNT,
    })

    // The very first session — the account's own oldest at the moment the
    // cap was hit — is the one that paid for it.
    const evicted = await sendMcpRequest(app, oldestSession, caller.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    })
    expect(evicted.status).toBe(404)

    // The ceiling is per-account, not global — a second account can still
    // start its own first session, and does not evict anything of the
    // first account's.
    const otherCaller = seedSignedInAccount(testDb.db)
    await expect(
      initializeMcpSession(app, otherCaller.token)
    ).resolves.toMatchObject({ sessionId: expect.any(String) })
    expect((await request(app).get('/health')).body).toMatchObject({
      sessions: MAX_SESSIONS_PER_ACCOUNT + 1,
    })
  })
})

describe('sweepIdleSessions — a pure function, driven by an injected clock rather than a real timer', () => {
  function buildFakeSession(
    accountId: string,
    lastActivityAt: number
  ): McpSession {
    return {
      transport: fakeTransport() as unknown as McpSession['transport'],
      accountId,
      lastActivityAt,
    }
  }

  it('closes and evicts a session idle past the timeout, and leaves a fresh one alone', () => {
    const now = 1_000_000
    const idleTimeoutMs = 60_000
    const sessions = new Map<string, McpSession>([
      ['idle', buildFakeSession('account-1', now - idleTimeoutMs - 1)],
      ['fresh', buildFakeSession('account-1', now - 1)],
      // Exactly at the boundary counts as idle — `now - lastActivityAt >= idleTimeoutMs`.
      ['boundary', buildFakeSession('account-1', now - idleTimeoutMs)],
    ])

    const closed = sweepIdleSessions(sessions, now, idleTimeoutMs)

    expect(closed.sort()).toEqual(['boundary', 'idle'])
    expect([...sessions.keys()]).toEqual(['fresh'])
    expect((sessions.get('fresh') as McpSession).lastActivityAt).toBe(now - 1)
  })

  it('calls close() on every transport it evicts', () => {
    const now = 1_000_000
    const idleTimeoutMs = 60_000
    const transport = fakeTransport()
    const sessions = new Map<string, McpSession>([
      [
        'idle',
        {
          transport: transport as unknown as McpSession['transport'],
          accountId: 'account-1',
          lastActivityAt: now - idleTimeoutMs - 1,
        },
      ],
    ])

    sweepIdleSessions(sessions, now, idleTimeoutMs)

    expect(transport.closed).toBe(true)
  })

  it('is a no-op against an empty map', () => {
    expect(sweepIdleSessions(new Map(), Date.now(), 60_000)).toEqual([])
  })
})
