/**
 * Test helper: an in-process fake of the OpenAI Conversations/Responses/
 * Files/Vector Stores APIs (MDL-7, FILE-1..3) — bound to `127.0.0.1:0` so
 * the OS picks a free port, never reaching a real network. Every test in
 * this package points its adapter's `baseUrl` at `server.baseUrl` instead
 * of `CONFIG.OPENAI_BASE_URL`'s real default, and asserts on
 * `server.requests` — the actual bodies the adapter sent — rather than
 * trusting the adapter's own account of itself.
 *
 * Each endpoint's response is programmable per test via `respondToConversations`/
 * `respondToResponses`/`respondToFiles`/`respondToVectorStoreCreate`/
 * `respondToVectorStoreFileAttach`/`respondToVectorStoreFileDelete`/
 * `respondToFileDelete` — a queue of one-shot responders, falling back to a
 * fixed default once the queue is empty, so a test can script "500 then
 * 200" (MDL-5) without the fake growing test-specific branches of its own.
 *
 * `POST /files` is the one endpoint whose request body is not JSON — the
 * real API takes `multipart/form-data`, so this fake parses it with the
 * runtime's own `Request#formData()` rather than hand-rolling a multipart
 * reader, and records the parsed `filename`/`contentType`/`content` on
 * `RecordedRequest.file` for a test to assert against.
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

/** What the fake recorded about a `POST /files` upload's own multipart body — `undefined` for every other endpoint. */
export interface RecordedFile {
  filename: string
  contentType: string
  content: Buffer
  purpose: string | undefined
}

/** What the fake recorded about one request, for a test to assert against. */
export interface RecordedRequest {
  method: string | undefined
  path: string
  headers: IncomingMessage['headers']
  body: unknown
  file?: RecordedFile
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

const DEFAULT_FILES_RESPONSE: FakeResponse = {
  status: 200,
  body: { id: 'file_default' },
}

const DEFAULT_VECTOR_STORE_CREATE_RESPONSE: FakeResponse = {
  status: 200,
  body: { id: 'vs_default' },
}

const DEFAULT_VECTOR_STORE_FILE_ATTACH_RESPONSE: FakeResponse = {
  status: 200,
  body: { status: 'completed' },
}

const DEFAULT_DELETE_RESPONSE: FakeResponse = {
  status: 200,
  body: { deleted: true },
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

/** One matchable route this fake answers — a fixed `method`/`path` pair (`/conversations`, `/files`, ...) or a `pathPattern` for a path carrying a provider-assigned id (`/vector_stores/:id/files`). */
interface Route {
  method: string
  test: (method: string | undefined, path: string) => boolean
  queue: Responder[]
  default: FakeResponse
}

export class FakeOpenAiServer {
  readonly requests: RecordedRequest[] = []

  private server: Server
  private conversationQueue: Responder[] = []
  private responsesQueue: Responder[] = []
  private filesQueue: Responder[] = []
  private vectorStoreCreateQueue: Responder[] = []
  private vectorStoreFileAttachQueue: Responder[] = []
  private vectorStoreFileDeleteQueue: Responder[] = []
  private fileDeleteQueue: Responder[] = []

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

  /** Queue one response for the next `POST /files` upload (FILE-1). */
  respondToFiles(response: FakeResponse | Responder): void {
    this.filesQueue.push(toResponder(response))
  }

  /** Queue one response for the next `POST /vector_stores` (FILE-1). */
  respondToVectorStoreCreate(response: FakeResponse | Responder): void {
    this.vectorStoreCreateQueue.push(toResponder(response))
  }

  /** Queue one response for the next `POST /vector_stores/:id/files` (FILE-1, FILE-2). */
  respondToVectorStoreFileAttach(response: FakeResponse | Responder): void {
    this.vectorStoreFileAttachQueue.push(toResponder(response))
  }

  /** Queue one response for the next `DELETE /vector_stores/:id/files/:fileId` (FILE-3). */
  respondToVectorStoreFileDelete(response: FakeResponse | Responder): void {
    this.vectorStoreFileDeleteQueue.push(toResponder(response))
  }

  /** Queue one response for the next `DELETE /files/:fileId` (FILE-3). */
  respondToFileDelete(response: FakeResponse | Responder): void {
    this.fileDeleteQueue.push(toResponder(response))
  }

  /** Every route this fake answers, most-specific first — `/vector_stores/:id/files` must be checked before the bare `/vector_stores` path would otherwise wrongly claim it. */
  private routes(): Route[] {
    return [
      {
        method: 'POST',
        test: (m, p) => m === 'POST' && p === '/conversations',
        queue: this.conversationQueue,
        default: DEFAULT_CONVERSATION_RESPONSE,
      },
      {
        method: 'POST',
        test: (m, p) => m === 'POST' && p === '/responses',
        queue: this.responsesQueue,
        default: DEFAULT_RESPONSES_RESPONSE,
      },
      {
        method: 'POST',
        test: (m, p) => m === 'POST' && p === '/files',
        queue: this.filesQueue,
        default: DEFAULT_FILES_RESPONSE,
      },
      {
        method: 'POST',
        test: (m, p) => m === 'POST' && p === '/vector_stores',
        queue: this.vectorStoreCreateQueue,
        default: DEFAULT_VECTOR_STORE_CREATE_RESPONSE,
      },
      {
        method: 'DELETE',
        test: (m, p) =>
          m === 'DELETE' && /^\/vector_stores\/[^/]+\/files\/[^/]+$/.test(p),
        queue: this.vectorStoreFileDeleteQueue,
        default: DEFAULT_DELETE_RESPONSE,
      },
      {
        method: 'POST',
        test: (m, p) =>
          m === 'POST' && /^\/vector_stores\/[^/]+\/files$/.test(p),
        queue: this.vectorStoreFileAttachQueue,
        default: DEFAULT_VECTOR_STORE_FILE_ATTACH_RESPONSE,
      },
      {
        method: 'DELETE',
        test: (m, p) => m === 'DELETE' && /^\/files\/[^/]+$/.test(p),
        queue: this.fileDeleteQueue,
        default: DEFAULT_DELETE_RESPONSE,
      },
    ]
  }

  private async handle(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    const raw = Buffer.concat(chunks)
    const path = req.url ?? ''
    const contentType = req.headers['content-type'] ?? ''

    let body: unknown
    let file: RecordedFile | undefined
    if (contentType.startsWith('multipart/form-data')) {
      // `POST /files` — parsed through the runtime's own `Request`, rather
      // than a hand-rolled multipart reader (this file's own module
      // comment).
      const form = await new Request('http://fake-openai.invalid/files', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: raw,
        // Node's `Request` requires this for a body on a same-origin-less
        // fake request; it changes nothing about what is actually read.
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }).formData()
      const purpose = form.get('purpose')
      const uploaded = form.get('file')
      if (uploaded instanceof File) {
        file = {
          filename: uploaded.name,
          contentType: uploaded.type,
          content: Buffer.from(await uploaded.arrayBuffer()),
          purpose: typeof purpose === 'string' ? purpose : undefined,
        }
      }
    } else if (raw.length > 0) {
      body = JSON.parse(raw.toString('utf8')) as unknown
    }

    const recorded: RecordedRequest = {
      method: req.method,
      path,
      headers: req.headers,
      body,
      ...(file ? { file } : {}),
    }
    this.requests.push(recorded)

    const route = this.routes().find((candidate) =>
      candidate.test(req.method, path)
    )
    if (!route) {
      res.writeHead(404)
      res.end()
      return
    }

    const result =
      route.queue.shift()?.(body, recorded) ??
      toResponder(route.default)(body, recorded)

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
