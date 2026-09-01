/**
 * Test helper: an in-process fake of the OpenAI Files/Vector Stores APIs
 * (FILE-1..3) — bound to `127.0.0.1:0`, never a real network call.
 * Duplicated from `packages/openai/tests/helpers/fake-openai-server.ts`
 * rather than imported across a package boundary test helpers are not
 * published through (that file's own module comment states the same
 * convention `discord-scaffold.test.ts`'s own helpers already follow) —
 * trimmed to only the endpoints `handlers/course-attachments.ts` actually
 * calls (no `/conversations`/`/responses`, this app's handlers never touch
 * either).
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'

export interface FakeResponse {
  status: number
  body: unknown
}

export interface RecordedFile {
  filename: string
  contentType: string
  content: Buffer
  purpose: string | undefined
}

export interface RecordedRequest {
  method: string | undefined
  path: string
  body: unknown
  file?: RecordedFile
}

type Responder = (body: unknown, request: RecordedRequest) => FakeResponse

function toResponder(response: FakeResponse | Responder): Responder {
  return typeof response === 'function' ? response : () => response
}

export class FakeOpenAiFilesServer {
  readonly requests: RecordedRequest[] = []

  private server: Server
  private filesQueue: Responder[] = []
  private vectorStoreCreateQueue: Responder[] = []
  private vectorStoreFileAttachQueue: Responder[] = []
  private vectorStoreFileDeleteQueue: Responder[] = []
  private fileDeleteQueue: Responder[] = []

  private constructor(server: Server) {
    this.server = server
  }

  static start(): Promise<FakeOpenAiFilesServer> {
    return new Promise((resolve) => {
      const server = createServer()
      const instance = new FakeOpenAiFilesServer(server)
      server.on('request', (req, res) => {
        void instance.handle(req, res)
      })
      server.listen(0, '127.0.0.1', () => resolve(instance))
    })
  }

  get baseUrl(): string {
    const address = this.server.address()
    if (!address || typeof address === 'string') {
      throw new Error(
        'FakeOpenAiFilesServer.baseUrl read before the server was listening'
      )
    }
    return `http://127.0.0.1:${address.port}`
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()))
    })
  }

  respondToFiles(response: FakeResponse | Responder): void {
    this.filesQueue.push(toResponder(response))
  }

  respondToVectorStoreCreate(response: FakeResponse | Responder): void {
    this.vectorStoreCreateQueue.push(toResponder(response))
  }

  respondToVectorStoreFileAttach(response: FakeResponse | Responder): void {
    this.vectorStoreFileAttachQueue.push(toResponder(response))
  }

  respondToVectorStoreFileDelete(response: FakeResponse | Responder): void {
    this.vectorStoreFileDeleteQueue.push(toResponder(response))
  }

  respondToFileDelete(response: FakeResponse | Responder): void {
    this.fileDeleteQueue.push(toResponder(response))
  }

  private route(
    method: string | undefined,
    path: string
  ): { queue: Responder[]; fallback: FakeResponse } | undefined {
    if (method === 'POST' && path === '/files') {
      return {
        queue: this.filesQueue,
        fallback: { status: 200, body: { id: 'file_default' } },
      }
    }
    if (method === 'POST' && path === '/vector_stores') {
      return {
        queue: this.vectorStoreCreateQueue,
        fallback: { status: 200, body: { id: 'vs_default' } },
      }
    }
    if (
      method === 'DELETE' &&
      /^\/vector_stores\/[^/]+\/files\/[^/]+$/.test(path)
    ) {
      return {
        queue: this.vectorStoreFileDeleteQueue,
        fallback: { status: 200, body: { deleted: true } },
      }
    }
    if (method === 'POST' && /^\/vector_stores\/[^/]+\/files$/.test(path)) {
      return {
        queue: this.vectorStoreFileAttachQueue,
        fallback: { status: 200, body: { status: 'completed' } },
      }
    }
    if (method === 'DELETE' && /^\/files\/[^/]+$/.test(path)) {
      return {
        queue: this.fileDeleteQueue,
        fallback: { status: 200, body: { deleted: true } },
      }
    }
    return undefined
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
      const form = await new Request('http://fake-openai.invalid/files', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: raw,
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
      body,
      ...(file ? { file } : {}),
    }
    this.requests.push(recorded)

    const route = this.route(req.method, path)
    if (!route) {
      res.writeHead(404)
      res.end()
      return
    }
    const result = route.queue.shift()?.(body, recorded) ?? route.fallback

    res.writeHead(result.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result.body))
  }
}
