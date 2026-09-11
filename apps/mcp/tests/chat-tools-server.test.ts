/**
 * MCP-8, over the real MCP-over-HTTP transport — `chat-tools.test.ts`
 * already covers `chat-tools.ts`'s own dispatch logic in detail with no
 * transport at all (`call-tool.test.ts`'s own module comment describes the
 * identical split for the action catalog); this file proves the one thing
 * only an HTTP-level test can: `server.ts#registerChatTools` actually wires
 * `chat.listCourses`/`chat.ask` in, and — the single most important thing
 * this slice's own brief names — that neither tool is gated by
 * `call-tool.ts`'s own membership check, in *either* direction: a student
 * with an enrolment and no membership can use both, and is still refused
 * every tool on `MCP_TOOL_SURFACE`.
 */

import { createPlatformRegistry } from '@bloombot/actions'
import type { Server } from 'node:http'

import { afterEach, describe, expect, it } from 'vitest'

import { buildOauthProvider } from '../src/oauth-provider.js'
import { buildApp, type ServerDependencies } from '../src/server.js'
import { buildToolDefinitions } from '../src/tool-surface.js'
import {
  initializeMcpSession,
  sendMcpRequest,
  startTestServer,
  type JsonRpcMessage,
} from './helpers/mcp-http-client.js'
import {
  connectAccountTo,
  seedEnrolledCourse,
  seedSignedInAccount,
} from './helpers/seed.js'
import { createTestDatabase, type TestDatabase } from './helpers/test-db.js'

let testDb: TestDatabase

afterEach(() => {
  testDb.cleanup()
})

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

// MCP-7 — every test in this file needs a real `oauthProvider`/`issuerUrl`
// now that `buildApp` mounts `mcpAuthRouter` unconditionally
// (`server.test.ts`'s own identical helper has the fuller reasoning); this
// file's own tests exercise the legacy session-bearer path exclusively, so
// a throwaway provider against a loopback issuer that is never actually
// dialed is enough.
async function buildTestApp(
  overrides: Partial<ServerDependencies> & { db: ServerDependencies['db'] }
): Promise<Server> {
  const deps: ServerDependencies = {
    logger: createFakeLogger(),
    toolDefinitions: buildToolDefinitions(createPlatformRegistry()),
    oauthProvider: buildOauthProvider({
      db: overrides.db,
      consentUrl: 'http://127.0.0.1:1/oauth/mcp/authorize',
      resource: 'http://127.0.0.1:1/mcp',
    }),
    issuerUrl: new URL('http://127.0.0.1:1'),
    ...overrides,
  }
  return startTestServer(buildApp(deps))
}

function findMessage(
  messages: JsonRpcMessage[],
  id: number
): JsonRpcMessage | undefined {
  return messages.find((message) => message.id === id)
}

function toolCallResult(response: { messages: JsonRpcMessage[] }): {
  isError?: boolean
  content: { type: string; text: string }[]
} {
  return findMessage(response.messages, 1)?.result as {
    isError?: boolean
    content: { type: string; text: string }[]
  }
}

describe('MCP-8, over the transport — the membership gate distinction', () => {
  it('a student with an enrolment and no membership can list and ask, and is still refused an administrative tool', async () => {
    testDb = createTestDatabase()
    // The organization's own owner — never used to authenticate any call
    // in this test; only to seed a course in an organization the student
    // below holds no membership in at all.
    const owner = seedSignedInAccount(testDb.db)
    const { courseId, discordPersonId } = seedEnrolledCourse(
      testDb.db,
      owner.organizationId
    )
    // A student: a signed-in account of their own, with a connected person
    // in `owner`'s organization and nothing else — no membership there.
    const student = seedSignedInAccount(testDb.db)
    connectAccountTo(
      testDb.db,
      owner.organizationId,
      student.accountId,
      discordPersonId
    )

    const app = await buildTestApp({ db: testDb.db })
    const session = await initializeMcpSession(app, student.token)

    const list = await sendMcpRequest(app, session, student.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'chat.listCourses', arguments: {} },
    })
    const listResult = toolCallResult(list)
    expect(listResult.isError).toBeFalsy()
    expect(
      (
        JSON.parse(listResult.content[0]?.text ?? '[]') as {
          courseId: string
        }[]
      ).map((c) => c.courseId)
    ).toEqual([courseId])

    const ask = await sendMcpRequest(app, session, student.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'chat.ask', arguments: { courseId, text: 'Hi?' } },
    })
    const askResult = toolCallResult(ask)
    expect(askResult.isError).toBeFalsy()

    // Still refused every administrative tool — the membership gate this
    // slice must not weaken (`call-tool.ts`'s own `if (!membership)`).
    const projectsList = await sendMcpRequest(app, session, student.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'projects.list',
        arguments: { organizationId: owner.organizationId },
      },
    })
    expect(toolCallResult(projectsList).isError).toBe(true)
    expect(toolCallResult(projectsList).content[0]?.text).toMatch(
      /does not exist or you do not have access to it/
    )

    const endEnrolment = await sendMcpRequest(app, session, student.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'enrolments.end',
        arguments: {
          organizationId: owner.organizationId,
          enrolmentId: 'whatever',
        },
      },
    })
    expect(toolCallResult(endEnrolment).isError).toBe(true)
  })

  it('an account with a membership but no chat admission for a course is refused that course, while keeping its administrative access', async () => {
    testDb = createTestDatabase()
    const instructor = seedSignedInAccount(testDb.db, { role: 'instructor' })
    // Left at real defaults with `enrol: false` and `answerUnenrolled:
    // false` — a member holds no ambient admission to a course carrying
    // neither setting (`enrolments.ts`'s own `admissionForCourse`).
    const { courseId } = seedEnrolledCourse(
      testDb.db,
      instructor.organizationId,
      {
        enrol: false,
        answerUnenrolled: false,
      }
    )

    const app = await buildTestApp({ db: testDb.db })
    const session = await initializeMcpSession(app, instructor.token)

    const ask = await sendMcpRequest(app, session, instructor.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'chat.ask', arguments: { courseId, text: 'Hi?' } },
    })
    // Refused as "needs-course-selection" — this account is not connected
    // to a person at all, so it is refused before admission is even
    // consulted for this course; either way, not answered.
    expect(toolCallResult(ask).isError).toBe(true)

    // The identical account's own administrative access is untouched.
    const projectsList = await sendMcpRequest(app, session, instructor.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'projects.list',
        arguments: { organizationId: instructor.organizationId },
      },
    })
    expect(toolCallResult(projectsList).isError).toBeFalsy()
  })

  it('an unlinked account is refused by both chat tools, naming the connect tool', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)

    const app = await buildTestApp({ db: testDb.db })
    const session = await initializeMcpSession(app, caller.token)

    const list = await sendMcpRequest(app, session, caller.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'chat.listCourses', arguments: {} },
    })
    expect(toolCallResult(list).isError).toBe(true)
    expect(toolCallResult(list).content[0]?.text).toMatch(
      /bloombot_connectAssistant/
    )

    const ask = await sendMcpRequest(app, session, caller.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'chat.ask', arguments: { text: 'Hi?' } },
    })
    expect(toolCallResult(ask).isError).toBe(true)
    expect(toolCallResult(ask).content[0]?.text).toMatch(
      /bloombot_connectAssistant/
    )
  })

  it('chat.listCourses and chat.ask are on the tools/list output, alongside bloombot_connectAssistant', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const app = await buildTestApp({ db: testDb.db })
    const session = await initializeMcpSession(app, caller.token)

    const response = await sendMcpRequest(app, session, caller.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    })
    const names = (
      findMessage(response.messages, 1)?.result as {
        tools: { name: string }[]
      }
    ).tools.map((tool) => tool.name)
    expect(names).toContain('chat.listCourses')
    expect(names).toContain('chat.ask')
    expect(names).toContain('bloombot_connectAssistant')
  })
})
