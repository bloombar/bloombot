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
 */

import type { Express } from 'express'
import request from 'supertest'

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
  app: Express,
  message: JsonRpcMessage,
  token: string | undefined,
  sessionId: string | undefined
): Promise<McpHttpResponse> {
  const req = request(app)
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
  app: Express,
  token: string
): Promise<McpSession> {
  const response = await postToMcp(
    app,
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
  app: Express,
  session: McpSession,
  token: string,
  message: JsonRpcMessage
): Promise<McpHttpResponse> {
  return postToMcp(app, message, token, session.sessionId)
}
