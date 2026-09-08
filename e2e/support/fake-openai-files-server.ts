/**
 * Test helper: an in-process fake of the OpenAI Files/Vector Stores APIs
 * (FILE-1..3) — bound to `127.0.0.1:0`, never a real network call (MDL-7).
 * Duplicated from `apps/worker/tests/helpers/fake-openai-files-server.ts`
 * rather than imported across a test-helper boundary — that file's own
 * module comment states the same convention (itself duplicated from
 * `packages/openai/tests/helpers/fake-openai-server.ts`): test helpers are
 * not published through package boundaries this repository otherwise
 * enforces for real code. Trimmed identically — only the endpoints
 * `apps/worker/src/handlers/course-attachments.ts` actually calls.
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

type Responder = (body: unknown) => FakeResponse

function toResponder(response: FakeResponse | Responder): Responder {
  return typeof response === 'function' ? response : () => response
}

export class FakeOpenAiFilesServer {
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
    if (!contentType.startsWith('multipart/form-data') && raw.length > 0) {
      body = JSON.parse(raw.toString('utf8')) as unknown
    }

    const route = this.route(req.method, path)
    if (!route) {
      res.writeHead(404)
      res.end()
      return
    }
    const result = route.queue.shift()?.(body) ?? route.fallback

    res.writeHead(result.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result.body))
  }
}
