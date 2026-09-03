/**
 * Test helper: the smallest amount of raw MCP-over-HTTP plumbing needed to
 * exercise `server.ts` end to end through `supertest`, with no
 * `@modelcontextprotocol/sdk` client in the loop — this app's own
 * `call-tool.test.ts`/`tool-surface.test.ts` already cover the dispatch
 * logic in detail with no transport at all; what only an HTTP-level test
 * can prove is that `server.ts` actually wires that logic to a real
 * request and session lifecycle.
 *
 * `server.ts` is a *stateful* transport (that file's own module comment on
 * why): a session starts with its own `initialize` call, and every request
 * after that must carry the `Mcp-Session-Id` header the initialize
 * response returns — a plain, sequential two-step client, not a real
 * `@modelcontextprotocol/sdk` `Client` (this app's own module comment: the
 * dispatch logic is testable without one; only the transport wiring needs
 * proving at all, and this is the minimum that proves it).
 *
 * **MCP-6 — every call here goes through `startTestServer`, never a bare
 * `request(app)`.** `docs/DECISIONS.md` D-24 already found and fixed this
 * exact class of bug for `apps/api`: `supertest`'s own `Test#serverAddress`
 * calls `app.listen(0)` with no host when handed a bare Express app, which
 * binds the IPv6 wildcard `::`, then dials the hard-coded literal
 * `http://127.0.0.1:<port>` — and `SO_REUSEADDR` lets the OS hand that
 * wildcard listen an ephemeral port some *other* process already holds
 * bound specifically to `127.0.0.1` (this machine runs plenty — VS Code's
 * helper sockets, a `vite` dev server, another test file's own server).
 * The more specific binding wins the connection, so the request never
 * reaches the app under test at all, and whatever that other process
 * answers gets parsed as if it had — indistinguishable from the app itself
 * returning a wrong status, because no code in `server.ts` ever ran.
 * D-24's own "Limits" section named this exactly: "If a future package adds
 * HTTP tests over supertest, it needs the same `startTestServer`-style
 * helper, not a bare `request(app)`" — this file was that future package,
 * and had not been. MCP-6's own investigation (an `MCP6_DEBUG` instrumented
 * build, run to reproduce, since removed) caught it directly: a failing
 * `initializeMcpSession` call left *zero* trace in `server.ts`'s own
 * request-entry logging, at every layer down to a catch-all Express
 * middleware registered before any routing at all — the request the test
 * thought it sent to this app never arrived, the same shape D-24 already
 * proved. `mcp-e2e.test.ts`'s own `listen()` already binds `127.0.0.1`
 * explicitly for the same reason (that file's own comment says so); this
 * file, the one every `server.test.ts` request actually goes through —
 * including the twenty-session eviction test, this bug's highest-volume
 * exposure in the whole repo — did not, until now.
 */

import { createServer, type Server } from 'node:http'

import type { Express } from 'express'
import request from 'supertest'
import { afterEach } from 'vitest'

// D-24 / MCP-6 — every server this file opens is tracked here so a test
// file never has to remember to close it itself; a single `afterEach`
// (registered at import time, so it runs once per test file under vitest's
// own per-file module isolation) closes whatever that file's tests opened.
// The same structural device `apps/api/tests/helpers/build-test-app.ts`
// already uses, duplicated rather than imported across an app boundary test
// helpers are not published through (this file's own sibling `test-db.ts`
// already states that convention).
const openServers = new Set<Server>()

afterEach(async () => {
  await Promise.all(
    Array.from(
      openServers,
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()))
        })
    )
  )
  openServers.clear()
})

/**
 * Binds `app` to `127.0.0.1` explicitly and awaits the bind before handing
 * back the listening server — `docs/DECISIONS.md` D-24's own "why the bind
 * has to be awaited, not patched around": `listen(0, '127.0.0.1')` runs
 * `dns.lookup` even for an IP literal, so it is asynchronous regardless of
 * how synchronous it looks, and there is no synchronous moment at which
 * `server.address()` has a real value to read. Every caller in this file
 * hands the result to `supertest`'s `request(...)`, which reads the address
 * off a server it did not create instead of picking one itself — the fix
 * this whole module comment describes.
 */
export function startTestServer(app: Express, port = 0): Promise<Server> {
  const server = createServer(app)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      openServers.add(server)
      resolve(server)
    })
  })
}

/** One JSON-RPC 2.0 message, loosely typed — enough for a test to read `result`/`error` off it. */
export interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

const PROTOCOL_VERSION = '2025-06-18'
const ACCEPT_HEADER = 'application/json, text/event-stream'

/** The SDK's own Streamable HTTP transport responds `text/event-stream`, one `data: <json>` line per message — parsed back into plain objects here. */
function parseEventStream(body: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = []
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue
    const json = line.slice('data:'.length).trim()
    if (!json) continue
    messages.push(JSON.parse(json) as JsonRpcMessage)
  }
  return messages
}

export interface McpHttpResponse {
  status: number
  headers: Record<string, string>
  /** Every JSON-RPC message an `text/event-stream` response carried, in the order the transport sent them — empty for a plain-JSON refusal (this app's own 401/404/500 shapes), read from `body` instead. */
  messages: JsonRpcMessage[]
  body: unknown
}

async function postToMcp(
  server: Server,
  message: JsonRpcMessage,
  token: string | undefined,
  sessionId: string | undefined
): Promise<McpHttpResponse> {
  const req = request(server)
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', ACCEPT_HEADER)
  if (token) req.set('Authorization', `Bearer ${token}`)
  if (sessionId) req.set('Mcp-Session-Id', sessionId)

  const response = await req.send(message)
  const contentType = response.headers['content-type'] ?? ''
  if (contentType.includes('text/event-stream')) {
    return {
      status: response.status,
      headers: response.headers as Record<string, string>,
      messages: parseEventStream(response.text),
      body: undefined,
    }
  }
  return {
    status: response.status,
    headers: response.headers as Record<string, string>,
    messages: [],
    body: response.body,
  }
}

/** One initialized MCP session — the `Mcp-Session-Id` every subsequent call in it must carry. */
export interface McpSession {
  sessionId: string
}

/** `initialize`, alone, in its own POST — `server.ts`'s own module comment on why a session must exist before anything else is sent. Throws if initialization itself failed, since every test that calls this needs a session to proceed at all. */
export async function initializeMcpSession(
  server: Server,
  token: string
): Promise<McpSession> {
  const response = await postToMcp(
    server,
    {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'apps/mcp test client', version: '0.0.0' },
      },
    },
    token,
    undefined
  )
  const sessionId = response.headers['mcp-session-id']
  if (response.status !== 200 || !sessionId) {
    throw new Error(
      `initializeMcpSession: initialize did not succeed (status ${response.status})`
    )
  }
  return { sessionId }
}

/** Sends one JSON-RPC request against an already-initialized session. */
export function sendMcpRequest(
  server: Server,
  session: McpSession,
  token: string,
  message: JsonRpcMessage
): Promise<McpHttpResponse> {
  return postToMcp(server, message, token, session.sessionId)
}

/** Terminates a session with `DELETE /mcp` (the MCP spec's own client-driven close) — `server.ts`'s own `onsessionclosed`/`onclose` wiring, exercised from the HTTP side. */
export async function closeMcpSession(
  server: Server,
  session: McpSession,
  token: string
): Promise<number> {
  const response = await request(server)
    .delete('/mcp')
    .set('Accept', ACCEPT_HEADER)
    .set('Authorization', `Bearer ${token}`)
    .set('Mcp-Session-Id', session.sessionId)
  return response.status
}
