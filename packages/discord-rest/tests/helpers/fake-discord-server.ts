/**
 * Test helper: a loopback stand-in for Discord's `/oauth2/token`,
 * `/users/@me/guilds`, `/guilds/{id}/channels`, `/guilds/{id}/roles` and
 * `/guilds/{id}/members` (ROST-10/ROST-11) endpoints — bound to
 * `127.0.0.1:0` so the OS picks a free port and no test
 * in this package reaches the real network, the same shape
 * `packages/openai/tests/helpers/fake-openai-server.ts` and
 * `packages/auth/tests/helpers/fake-google-server.ts` already use for their
 * own vendors.
 *
 * `/users/@me/guilds` is one URL Discord itself reuses for both the user's
 * own guild list and the bot's — which one a request gets back is decided
 * here by the `Authorization` header's own scheme (`Bearer` vs `Bot`), the
 * same way the real API does. `setUserGuilds`/`setBotGuilds` each take the
 * *whole* list; this fake pages it out itself, honoring `limit`/`after` the
 * same way the real endpoint does, so a test can prove `client.ts` actually
 * walks every page (finding 3 of the TEN-4..6 rework) against a fake that
 * genuinely withholds a second page rather than returning everything at
 * once regardless of `limit`.
 *
 * SRV-6's guild-write endpoints are stateful, not fixed responses: `POST
 * /guilds/{id}/channels` actually appends the created category or channel to
 * this fake's own per-guild store, assigns it an id, and echoes it back —
 * so a second `GET /guilds/{id}/channels` (or a second create call in the
 * same test) sees exactly what the first call created. That statefulness is
 * what lets a test prove SRV-7's idempotence against this fake directly
 * (run a handler twice, assert the second run's create calls are zero)
 * rather than only against the handler's own report. This fake implements
 * no route that edits or deletes a channel or category at all — the same
 * structural absence `client.ts`'s own module comment describes for
 * `DiscordRestClient` itself (SRV-8): there is nothing for a test to call
 * even if a caller wanted to.
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
  /** Parsed as `application/json` for a guild-write call, as `application/x-www-form-urlencoded` key/value pairs for the token endpoint's `POST`, or left `undefined` for a bodyless `GET` — whichever this request actually carried. */
  body: Record<string, string> | Record<string, unknown> | undefined
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
  // SRV-6 — one channel/category list and one role list per guild id, so a
  // test can seed more than one guild independently. `POST
  // /guilds/{id}/channels` (below) appends to `guildChannels` itself, which
  // is what makes this fake's create calls actually idempotent to a second
  // `GET`/`POST` against the same guild, not merely a fixed canned response.
  private guildChannels = new Map<string, unknown[]>()
  private guildRoles = new Map<string, unknown[]>()
  // ROST-10/ROST-11 — one member list per guild id, paginated the same way
  // `userGuilds`/`botGuilds` above already are for `/users/@me/guilds`.
  private guildMembers = new Map<string, unknown[]>()
  private guildChannelsQueue: (FakeResponse | undefined)[] = []
  private nextChannelId = 1

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

  /** Queue one response for the next call to `/guilds/{id}/channels`, whichever guild it names and whether it is the `GET` (list) or `POST` (create) — for a test proving `listGuildChannels`/`createGuildCategory`/`createGuildChannel` surface a non-2xx response rather than assuming every call succeeds. */
  respondToGuildChannels(response: FakeResponse): void {
    this.guildChannelsQueue.push(response)
  }

  /** What `getUserGuilds` (an `Authorization: Bearer ...` call) returns for every subsequent request, until changed again. */
  setUserGuilds(guilds: unknown[]): void {
    this.userGuilds = guilds
  }

  /** What `getBotGuilds` (an `Authorization: Bot ...` call) returns for every subsequent request, until changed again. */
  setBotGuilds(guilds: unknown[]): void {
    this.botGuilds = guilds
  }

  /** Seed `guildId`'s existing channels/categories (Discord's own raw shape — `parent_id`, not `parentId`) — what `listGuildChannels` reads, and what a create call's own "does this already exist" match runs against. */
  setGuildChannels(guildId: string, channels: unknown[]): void {
    this.guildChannels.set(guildId, [...channels])
  }

  /** Seed `guildId`'s roles (Discord's own raw shape — `{ id, name, ... }`). */
  setGuildRoles(guildId: string, roles: unknown[]): void {
    this.guildRoles.set(guildId, roles)
  }

  /** Seed `guildId`'s members (Discord's own raw shape — `{ user: { id, username, global_name }, nick }`). */
  setGuildMembers(guildId: string, members: unknown[]): void {
    this.guildMembers.set(guildId, members)
  }

  /** `guildId`'s channels/categories as they stand right now — including anything a create call has appended since `setGuildChannels` — for a test that wants to assert on guild state directly rather than only on `requests`. */
  guildChannelsFor(guildId: string): unknown[] {
    return this.guildChannels.get(guildId) ?? []
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

    // A guild-write call (`postJson` in `../../src/http.ts`) sends
    // `application/json`; the token endpoint (`postForm`) sends
    // `application/x-www-form-urlencoded` — parsed accordingly so
    // `recorded.body` (and the create handlers below) see the same shape
    // the real endpoint would.
    const isJson = (req.headers['content-type'] ?? '').includes(
      'application/json'
    )
    const parsedBody = raw
      ? isJson
        ? (JSON.parse(raw) as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(raw))
      : undefined

    const recorded: RecordedRequest = {
      method: req.method,
      path: req.url ?? '',
      headers: req.headers,
      body: parsedBody,
    }
    this.requests.push(recorded)

    if (req.method === 'POST' && req.url === '/token') {
      const response = this.tokenQueue.shift() ?? DEFAULT_TOKEN_RESPONSE
      this.respondJson(res, response.status, response.body)
      return
    }

    const [pathname, query] = (req.url ?? '').split('?')
    if (req.method === 'GET' && pathname === '/users/@me/guilds') {
      const queued = this.guildsQueue.shift()
      if (queued) {
        this.respondJson(res, queued.status, queued.body)
        return
      }
      const authorization = req.headers.authorization ?? ''
      let full: unknown[]
      if (authorization.startsWith('Bearer ')) {
        full = this.userGuilds
      } else if (authorization.startsWith('Bot ')) {
        full = this.botGuilds
      } else {
        this.respondJson(res, 401, { message: '401: Unauthorized' })
        return
      }
      // Finding 3 of the TEN-4..6 rework: paginate the stored list the same
      // way the real endpoint does — `limit` entries at a time, starting
      // just after `after`'s id — so a test can prove `client.ts#getGuilds`
      // actually walks every page rather than reading only the first.
      const params = new URLSearchParams(query)
      const limit = Number(params.get('limit') ?? '200')
      const after = params.get('after')
      let startIndex = 0
      if (after) {
        const index = full.findIndex(
          (guild) => (guild as { id?: string }).id === after
        )
        startIndex = index === -1 ? full.length : index + 1
      }
      this.respondJson(res, 200, full.slice(startIndex, startIndex + limit))
      return
    }

    // SRV-6's four guild-write endpoints — `/guilds/{id}/channels` (list and
    // create; Discord reuses the one URL for both, split here by method the
    // same way `/token` vs `/users/@me/guilds` already are above) and
    // `/guilds/{id}/roles` (list only — nothing in this package ever writes
    // a role).
    const channelsMatch = /^\/guilds\/([^/]+)\/channels$/.exec(pathname ?? '')
    if (channelsMatch) {
      const guildId = channelsMatch[1] ?? ''
      const queued = this.guildChannelsQueue.shift()
      if (queued) {
        this.respondJson(res, queued.status, queued.body)
        return
      }
      if (req.method === 'GET') {
        this.respondJson(res, 200, this.guildChannels.get(guildId) ?? [])
        return
      }
      if (req.method === 'POST') {
        const created = {
          id: String(this.nextChannelId++),
          parent_id: null,
          ...(parsedBody as Record<string, unknown>),
        }
        const existing = this.guildChannels.get(guildId) ?? []
        this.guildChannels.set(guildId, [...existing, created])
        this.respondJson(res, 200, created)
        return
      }
    }

    const rolesMatch = /^\/guilds\/([^/]+)\/roles$/.exec(pathname ?? '')
    if (req.method === 'GET' && rolesMatch) {
      const guildId = rolesMatch[1] ?? ''
      this.respondJson(res, 200, this.guildRoles.get(guildId) ?? [])
      return
    }

    // ROST-10/ROST-11 — paginated the same way `/users/@me/guilds` is
    // above, so a test can prove `client.ts#listGuildMembers` actually
    // walks every page.
    const membersMatch = /^\/guilds\/([^/]+)\/members$/.exec(pathname ?? '')
    if (req.method === 'GET' && membersMatch) {
      const guildId = membersMatch[1] ?? ''
      const full = this.guildMembers.get(guildId) ?? []
      const params = new URLSearchParams(query)
      const limit = Number(params.get('limit') ?? '1000')
      const after = params.get('after')
      let startIndex = 0
      if (after) {
        const index = full.findIndex(
          (member) => (member as { user?: { id?: string } }).user?.id === after
        )
        startIndex = index === -1 ? full.length : index + 1
      }
      this.respondJson(res, 200, full.slice(startIndex, startIndex + limit))
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
