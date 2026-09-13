/**
 * MCP-9, over the real MCP-over-HTTP transport — `admin-tools.test.ts`
 * already covers `admin-tools.ts`'s own dispatch logic in detail with no
 * transport at all (`call-tool.test.ts`'s own module comment describes the
 * identical split for the action catalog); this file proves the things only
 * an HTTP-level test can: `server.ts#registerAdminTools` actually wires
 * `courses.listAdministered` in over the real session/tool-call path; a
 * student reachable only through an enrolment (no membership) never sees
 * anything through it even though `chat.listCourses` (MCP-8) admits them
 * (the same distinction `chat-tools-server.test.ts` proves in the other
 * direction); and the "no administrative membership anywhere" text is
 * reserved for an account that genuinely holds none, never one that merely
 * administers an organization with no courses yet (must-fix 1's own rework
 * finding — a first version of this file's own "no membership" case used
 * `seedSignedInAccount` without revoking anything, which always grants a
 * membership in a fresh personal organization, so it exercised the
 * zero-courses path while asserting the no-membership text; it passed only
 * because the two branches produced the same wording before this rework).
 */

import { createPlatformRegistry } from '@bloombot/actions'
import type { Server } from 'node:http'

import { memberships } from '@bloombot/db'
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
  seedCourse,
  seedEnrolledCourse,
  seedSecondOrganizationForAccount,
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
// (`server.test.ts`'s own identical helper has the fuller reasoning); these
// tests exercise the legacy session-bearer path exclusively, so a throwaway
// provider against a loopback issuer that is never actually dialed is
// enough.
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

describe('courses.listAdministered, over the transport (MCP-9)', () => {
  it('is wired in and lists organizations, and their courses, across every organization the account administers', async () => {
    testDb = createTestDatabase()
    const caller = seedSignedInAccount(testDb.db)
    const { courseId: firstCourseId } = seedCourse(
      testDb.db,
      caller.organizationId,
      { title: 'First Org Course' }
    )
    const secondOrganizationId = seedSecondOrganizationForAccount(
      testDb.db,
      caller.accountId
    )
    const { courseId: secondCourseId } = seedCourse(
      testDb.db,
      secondOrganizationId,
      { title: 'Second Org Course' }
    )

    const app = await buildTestApp({ db: testDb.db })
    const session = await initializeMcpSession(app, caller.token)

    const response = await sendMcpRequest(app, session, caller.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'courses.listAdministered', arguments: {} },
    })
    const result = toolCallResult(response)
    expect(result.isError).toBeFalsy()
    const listed = JSON.parse(result.content[0]?.text ?? '[]') as {
      organizationId: string
      courses: { courseId: string }[]
    }[]
    expect(listed.map((org) => org.organizationId).sort()).toEqual(
      [caller.organizationId, secondOrganizationId].sort()
    )
    expect(
      listed.flatMap((org) => org.courses.map((c) => c.courseId)).sort()
    ).toEqual([firstCourseId, secondCourseId].sort())
  })

  it('lists an organization with an empty courses array when it administers one with no courses yet — must-fix 1', async () => {
    testDb = createTestDatabase()
    // No course seeded at all — the fresh-organization case must-fix 1
    // exists for: `projects.create`/`courses.save` both need this
    // organizationId, and this tool is the only place to learn it.
    const caller = seedSignedInAccount(testDb.db)

    const app = await buildTestApp({ db: testDb.db })
    const session = await initializeMcpSession(app, caller.token)

    const response = await sendMcpRequest(app, session, caller.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'courses.listAdministered', arguments: {} },
    })
    const result = toolCallResult(response)
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(result.content[0]?.text ?? 'null')).toEqual([
      {
        organizationId: caller.organizationId,
        organizationName: expect.any(String),
        courses: [],
      },
    ])
  })

  it('a student reachable only through an enrolment (no membership) does not see that organization here, though chat.listCourses admits them there', async () => {
    testDb = createTestDatabase()
    const owner = seedSignedInAccount(testDb.db)
    const { discordPersonId } = seedEnrolledCourse(
      testDb.db,
      owner.organizationId
    )
    const student = seedSignedInAccount(testDb.db)
    connectAccountTo(
      testDb.db,
      owner.organizationId,
      student.accountId,
      discordPersonId
    )

    const app = await buildTestApp({ db: testDb.db })
    const session = await initializeMcpSession(app, student.token)

    const chatList = await sendMcpRequest(app, session, student.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'chat.listCourses', arguments: {} },
    })
    // Proves this is genuinely the "enrolled, no membership" case, not one
    // this account cannot reach at all — the same shape
    // `chat-tools-server.test.ts` already pins for MCP-8.
    expect(toolCallResult(chatList).isError).toBeFalsy()

    const administeredList = await sendMcpRequest(app, session, student.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'courses.listAdministered', arguments: {} },
    })
    const result = toolCallResult(administeredList)
    expect(result.isError).toBeFalsy()
    // `student` still administers its own personal organization (`courses:
    // []`, from `seedSignedInAccount`) — `owner`'s organization specifically
    // is what must not appear, not the whole result (cheap-fix 3: an
    // earlier version of this test could not tell the two apart, since it
    // asserted the whole-list-empty text that only a genuinely
    // membership-free account should ever see — the next test pins that
    // case directly).
    const listed = JSON.parse(result.content[0]?.text ?? '[]') as {
      organizationId: string
    }[]
    expect(
      listed.some((org) => org.organizationId === owner.organizationId)
    ).toBe(false)
  })

  it('an account with no active membership anywhere is told so plainly, not handed an empty array to interpret', async () => {
    testDb = createTestDatabase()
    // `assistant`, not `owner` — the last-owner invariant
    // (`memberships.ts`'s own `revokeMembership` doc comment) would refuse
    // revoking a sole `owner` membership, so this is the one role that lets
    // a real, seeded account end up with genuinely none.
    const caller = seedSignedInAccount(testDb.db, { role: 'assistant' })
    const revoked = memberships.revokeMembership(
      caller.organizationId,
      { accountId: caller.accountId, revokedByAccountId: caller.accountId },
      testDb.db
    )
    if (!revoked) throw new Error('setup failed: could not revoke membership')

    const app = await buildTestApp({ db: testDb.db })
    const session = await initializeMcpSession(app, caller.token)

    const response = await sendMcpRequest(app, session, caller.token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'courses.listAdministered', arguments: {} },
    })
    const result = toolCallResult(response)
    expect(result.isError).toBeFalsy()
    // A plain sentence, not a JSON array — this account is told so plainly
    // (MCP-9's own SPEC text), never handed `[]` alone to interpret.
    expect(result.content[0]?.text).toMatch(
      /does not hold an administrative membership/
    )
  })
})
