/**
 * Test helper: a loopback stand-in for the four SRV-6 guild-management
 * endpoints `discord-scaffold.ts`'s handler calls through
 * `@bloombot/discord-rest` — `GET`/`POST /guilds/{id}/channels` and `GET
 * /guilds/{id}/roles` — bound to `127.0.0.1:0` so the OS picks a free port
 * and no test in this app reaches the real network. Duplicated from
 * `packages/discord-rest/tests/helpers/fake-discord-server.ts` rather than
 * imported across a package boundary test helpers are not published
 * through (that file's own module comment states the same convention),
 * narrowed to only the endpoints this app's own handler actually calls —
 * no `/token` or `/users/@me/guilds`, since this process never does an
 * OAuth exchange.
 *
 * Stateful, not fixed responses: `POST /guilds/{id}/channels` actually
 * appends the created category or channel to this fake's own per-guild
 * store and echoes it back, so a second `GET`/`POST` against the same guild
 * — including a second full run of the handler, in the same test — sees
 * exactly what the first call created. That is what lets SRV-7's
 * idempotence test assert against this fake's own recorded requests (zero
 * creates on a second run), not only against the handler's own report.
 * This fake implements no route that edits or deletes a channel or
 * category — SRV-8's "never delete" has nothing to call even if a test
 * wanted to prove otherwise by accident.
 *
 * Finding 1 of the SRV-6..8 rework: a created `GUILD_TEXT` channel's own
 * `name` is slugged before it is stored and echoed back — lowercased, each
 * run of whitespace collapsed to a single `-` — the same transform Discord's
 * real API silently applies at creation and that this fake used to skip,
 * which is exactly why the bug this rework fixes (a declared channel with a
 * space in its name duplicating on every run) went unnoticed: a fake that
 * merely echoes whatever it was posted never disagrees with a handler that
 * only compares declared names. A `GUILD_CATEGORY`'s own `name` is left
 * untouched — Discord does not slug a category's name the same way.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'

export interface RecordedRequest {
  method: string | undefined
  path: string
  headers: IncomingMessage['headers']
  body: Record<string, unknown> | undefined
}

/** Discord's own channel-type enum (API v10) — `0` is `GUILD_TEXT`, the only type this fake slugs a created name for; see this file's own module comment. */
const CHANNEL_TYPE_GUILD_TEXT = 0

/** Discord's own slugging of a `GUILD_TEXT` channel's name at creation — lowercase, whitespace runs collapsed to a single `-`. See this file's own module comment for why echoing it here (finding 1 of the SRV-6..8 rework) matters. */
function slugifyChannelName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '-')
}

export class FakeDiscordGuildServer {
  readonly requests: RecordedRequest[] = []

  private server: Server
  private guildChannels = new Map<string, unknown[]>()
  private guildRoles = new Map<string, unknown[]>()
  private nextChannelId = 1

  private constructor(server: Server) {
    this.server = server
  }

  static start(): Promise<FakeDiscordGuildServer> {
    return new Promise((resolve) => {
      const server = createServer()
      const instance = new FakeDiscordGuildServer(server)
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
        'FakeDiscordGuildServer.baseUrl read before the server was listening'
      )
    }
    return `http://127.0.0.1:${address.port}`
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()))
    })
  }

  /** Seed `guildId`'s existing channels/categories (Discord's own raw shape — `parent_id`, not `parentId`). */
  setGuildChannels(guildId: string, channels: unknown[]): void {
    this.guildChannels.set(guildId, [...channels])
  }

  /** Seed `guildId`'s roles (Discord's own raw shape — `{ id, name, ... }`). */
  setGuildRoles(guildId: string, roles: unknown[]): void {
    this.guildRoles.set(guildId, roles)
  }

  /** `guildId`'s channels/categories as they stand right now — including anything a create call has appended since `setGuildChannels`, and with a `GUILD_TEXT` channel's name already slugged — the same escape hatch `packages/discord-rest`'s own `FakeDiscordServer#guildChannelsFor` provides, for a test that wants to assert on the guild's actual state rather than only on `requests`/`writeRequests()`. */
  guildChannelsFor(guildId: string): unknown[] {
    return this.guildChannels.get(guildId) ?? []
  }

  /** Every `POST`/`PATCH`/`DELETE` this fake has ever received — a test's own structural proof, alongside `DiscordRestClient`'s own missing methods, that SRV-8 held: no delete call of any kind reached even a fake willing to record one. */
  writeRequests(): RecordedRequest[] {
    return this.requests.filter((request) => request.method !== 'GET')
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
    const parsedBody = raw
      ? (JSON.parse(raw) as Record<string, unknown>)
      : undefined

    const [pathname] = (req.url ?? '').split('?')
    this.requests.push({
      method: req.method,
      path: req.url ?? '',
      headers: req.headers,
      body: parsedBody,
    })

    const channelsMatch = /^\/guilds\/([^/]+)\/channels$/.exec(pathname ?? '')
    if (channelsMatch) {
      const guildId = channelsMatch[1] ?? ''
      if (req.method === 'GET') {
        this.respondJson(res, 200, this.guildChannels.get(guildId) ?? [])
        return
      }
      if (req.method === 'POST') {
        const postedName = parsedBody?.['name']
        const postedType = parsedBody?.['type']
        const created = {
          id: String(this.nextChannelId++),
          parent_id: null,
          ...parsedBody,
          // Finding 1 of the SRV-6..8 rework — see this file's own module
          // comment: a `GUILD_TEXT` channel's `name` is slugged the way
          // Discord's real API slugs it; a `GUILD_CATEGORY`'s is not.
          ...(postedType === CHANNEL_TYPE_GUILD_TEXT &&
          typeof postedName === 'string'
            ? { name: slugifyChannelName(postedName) }
            : {}),
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
