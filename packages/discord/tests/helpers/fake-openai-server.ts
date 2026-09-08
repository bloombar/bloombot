/**
 * Test helper: an in-process fake of the OpenAI Conversations/Responses
 * APIs (MDL-7) — bound to `127.0.0.1:0` so the OS picks a free port, never
 * reaching a real network. Every test in this package points its adapter's
 * `baseUrl` at `server.baseUrl` instead of `CONFIG.OPENAI_BASE_URL`'s real
 * default, and asserts on `server.requests` — the actual bodies the
 * adapter sent — rather than trusting the adapter's own account of itself.
 *
 * Each endpoint's response is programmable per test via `respondToConversations`/
 * `respondToResponses` — a queue of one-shot responders, falling back to a
 * fixed default once the queue is empty, so a test can script "500 then
 * 200" (MDL-5) without the fake growing test-specific branches of its own.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'

/** One programmed reply for a single incoming request. `delayMs` lets a test simulate a slow upstream (MDL-5's timeout). */
export interface FakeResponse {
  status: number
  body: unknown
  delayMs?: number
}

/** What the fake recorded about one request, for a test to assert against. */
export interface RecordedRequest {
  method: string | undefined
  path: string
  headers: IncomingMessage['headers']
  body: unknown
}

type Responder = (body: unknown, request: RecordedRequest) => FakeResponse

const DEFAULT_CONVERSATION_RESPONSE: FakeResponse = {
  status: 200,
  body: { id: 'conv_default' },
}

const DEFAULT_RESPONSES_RESPONSE: FakeResponse = {
  status: 200,
  body: fakeResponsesPayload('a fake answer'),
}

/** Build a Responses API success payload with the real API's `output`/`usage` shape (`responses.ts`'s `extractOutputText` walks exactly this). */
export function fakeResponsesPayload(
  text: string,
  usage: { input_tokens: number; output_tokens: number } = {
    input_tokens: 12,
    output_tokens: 34,
  }
): unknown {
  return {
    id: 'resp_fake',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
    usage,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class FakeOpenAiServer {
  readonly requests: RecordedRequest[] = []

  private server: Server
  private conversationQueue: Responder[] = []
  private responsesQueue: Responder[] = []

  private constructor(server: Server) {
    this.server = server
  }

  /** Start listening on `127.0.0.1:0` and resolve once the OS has assigned a port. */
  static start(): Promise<FakeOpenAiServer> {
    return new Promise((resolve) => {
      // The request listener is attached after construction (rather than
      // passed to `createServer` directly) so it can close over `instance`
      // without needing a forward-declared, reassigned local.
      const server = createServer()
      const instance = new FakeOpenAiServer(server)
      server.on('request', (req, res) => {
        void instance.handle(req, res)
      })
      server.listen(0, '127.0.0.1', () => resolve(instance))
    })
  }

  /** `http://127.0.0.1:<port>` — no `/v1` suffix; endpoints below are mounted at their bare paths, matching how `postJson` builds `${baseUrl}${path}`. */
  get baseUrl(): string {
    const address = this.server.address()
    if (!address || typeof address === 'string') {
      throw new Error(
        'FakeOpenAiServer.baseUrl read before the server was listening'
      )
    }
    return `http://127.0.0.1:${address.port}`
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()))
    })
  }

  /** Queue one response for the next `POST /conversations`. Fixed responses (not functions) are the common case; pass a function to inspect the request body first. */
  respondToConversations(response: FakeResponse | Responder): void {
    this.conversationQueue.push(toResponder(response))
  }

  /** Queue one response for the next `POST /responses`. */
  respondToResponses(response: FakeResponse | Responder): void {
    this.responsesQueue.push(toResponder(response))
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw ? (JSON.parse(raw) as unknown) : undefined

    const recorded: RecordedRequest = {
      method: req.method,
      path: req.url ?? '',
      headers: req.headers,
      body,
    }
    this.requests.push(recorded)

    const queue =
      req.url === '/conversations'
        ? this.conversationQueue
        : req.url === '/responses'
          ? this.responsesQueue
          : undefined
    if (!queue) {
      res.writeHead(404)
      res.end()
      return
    }

    const responder =
      queue.shift() ??
      toResponder(
        req.url === '/conversations'
          ? DEFAULT_CONVERSATION_RESPONSE
          : DEFAULT_RESPONSES_RESPONSE
      )
    const result = responder(body, recorded)

    if (result.delayMs) {
      await sleep(result.delayMs)
    }
    // A timeout test's client has already aborted by the time a delayed
    // responder resolves — writing to a closed socket would throw and fail
    // the test for the wrong reason, so this is checked rather than assumed.
    if (res.writableEnded || res.destroyed) return

    res.writeHead(result.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result.body))
  }
}

function toResponder(response: FakeResponse | Responder): Responder {
  return typeof response === 'function' ? response : () => response
}
