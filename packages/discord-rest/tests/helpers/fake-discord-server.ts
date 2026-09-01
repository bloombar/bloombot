/**
 * Test helper: a loopback stand-in for Discord's `/oauth2/token` and
 * `/users/@me/guilds` endpoints — bound to `127.0.0.1:0` so the OS picks a
 * free port and no test in this package reaches the real network, the same
 * shape `packages/openai/tests/helpers/fake-openai-server.ts` and
 * `packages/auth/tests/helpers/fake-google-server.ts` already use for their
 * own vendors.
 *
 * `/users/@me/guilds` is one URL Discord itself reuses for both the user's
 * own guild list and the bot's — which one a request gets back is decided
 * here by the `Authorization` header's own scheme (`Bearer` vs `Bot`), the
 * same way the real API does.
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

export interface RecordedRequest {
  method: string | undefined
  path: string
  headers: IncomingMessage['headers']
  /** Parsed as JSON for a `GET`, or as `application/x-www-form-urlencoded` key/value pairs for the token endpoint's `POST` — whichever this body actually was. */
  body: Record<string, string> | undefined
}

const DEFAULT_TOKEN_RESPONSE: FakeResponse = {
  status: 200,
  body: {
    access_token: 'fake-user-access-token',
    token_type: 'Bearer',
    expires_in: 604800,
    scope: 'identify guilds bot',
  },
}

export class FakeDiscordServer {
  readonly requests: RecordedRequest[] = []

  private server: Server
  private tokenQueue: (FakeResponse | undefined)[] = []
  private guildsQueue: (FakeResponse | undefined)[] = []
  private userGuilds: unknown[] = []
  private botGuilds: unknown[] = []

  private constructor(server: Server) {
    this.server = server
  }

  static start(): Promise<FakeDiscordServer> {
    return new Promise((resolve) => {
      const server = createServer()
      const instance = new FakeDiscordServer(server)
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
        'FakeDiscordServer.baseUrl read before the server was listening'
      )
    }
    return `http://127.0.0.1:${address.port}`
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()))
    })
  }

  /** Queue one response for the next `POST /token`. Falls back to a fixed successful exchange once the queue is empty. */
  respondToToken(response: FakeResponse): void {
    this.tokenQueue.push(response)
  }

  /** Queue one response for the next `GET /users/@me/guilds`, overriding `setUserGuilds`/`setBotGuilds` for that one call — for a test proving the client surfaces a non-2xx guild-list response rather than assuming every call succeeds. */
  respondToGuilds(response: FakeResponse): void {
    this.guildsQueue.push(response)
  }

  /** What `getUserGuilds` (an `Authorization: Bearer ...` call) returns for every subsequent request, until changed again. */
  setUserGuilds(guilds: unknown[]): void {
    this.userGuilds = guilds
  }

  /** What `getBotGuilds` (an `Authorization: Bot ...` call) returns for every subsequent request, until changed again. */
  setBotGuilds(guilds: unknown[]): void {
    this.botGuilds = guilds
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

    const recorded: RecordedRequest = {
      method: req.method,
      path: req.url ?? '',
      headers: req.headers,
      body: raw ? Object.fromEntries(new URLSearchParams(raw)) : undefined,
    }
    this.requests.push(recorded)

    if (req.method === 'POST' && req.url === '/token') {
      const response = this.tokenQueue.shift() ?? DEFAULT_TOKEN_RESPONSE
      this.respondJson(res, response.status, response.body)
      return
    }

    if (req.method === 'GET' && req.url === '/users/@me/guilds') {
      const queued = this.guildsQueue.shift()
      if (queued) {
        this.respondJson(res, queued.status, queued.body)
        return
      }
      const authorization = req.headers.authorization ?? ''
      if (authorization.startsWith('Bearer ')) {
        this.respondJson(res, 200, this.userGuilds)
        return
      }
      if (authorization.startsWith('Bot ')) {
        this.respondJson(res, 200, this.botGuilds)
        return
      }
      this.respondJson(res, 401, { message: '401: Unauthorized' })
      return
    }

    res.writeHead(404)
    res.end()
  }

  private respondJson(
    res: ServerResponse,
    status: number,
    body: unknown
  ): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
}
