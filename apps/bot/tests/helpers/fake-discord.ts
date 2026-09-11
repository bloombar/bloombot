/**
 * Test helper: the handful of discord.js `Client`/`Guild`/`GuildTextBasedChannel`/
 * `Message` properties `runCatchUp` (`catch-up.ts`) actually reads, shaped as
 * plain fakes — no real gateway connection, no real `Message` — cast to the
 * real discord.js types at the call site, the same device
 * `apps/bot/tests/inbound.test.ts`'s own `fakeMessage` already uses.
 */

import { vi } from 'vitest'

import type {
  Client,
  Guild,
  GuildMember,
  GuildTextBasedChannel,
  Message,
} from 'discord.js'

let messageCounter = 0

export interface FakeMessageOptions {
  id?: string
  /** Epoch milliseconds — what `message.createdTimestamp` reports. */
  createdTimestamp?: number
  guildId?: string
  channelId?: string
  channelName?: string
  categoryName?: string | null
  authorId?: string
  authorUsername?: string
  authorIsBot?: boolean
  content?: string
  repliedUserId?: string | null
}

/** A fake `GuildMember` — the shape `guild.members.fetch` (MF-D) resolves to by default. */
export function fakeGuildMember(
  options: { displayName?: string; roleNames?: string[] } = {}
) {
  const member = {
    displayName: options.displayName ?? 'Student Name',
    roles: {
      cache: {
        map: (fn: (role: { name: string }) => string) =>
          (options.roleNames ?? []).map((name) => fn({ name })),
      },
    },
  }
  return member as unknown as GuildMember
}

/** One fake message — satisfies everything `buildInboundMention` reads, plus `.id`/`.createdTimestamp`/`.inGuild()`/`.reply()`, which `runCatchUp` reads directly. */
export function fakeMessage(options: FakeMessageOptions = {}) {
  messageCounter += 1
  const id = options.id ?? `msg-${messageCounter}`
  const message = {
    id,
    createdTimestamp: options.createdTimestamp ?? Date.now(),
    guild: { id: options.guildId ?? 'guild-1' },
    guildId: options.guildId ?? 'guild-1',
    channelId: options.channelId ?? 'channel-1',
    channel: {
      id: options.channelId ?? 'channel-1',
      name: options.channelName ?? 'general',
      isThread: () => false as const,
      parent:
        options.categoryName == null ? null : { name: options.categoryName },
    },
    author: {
      id: options.authorId ?? 'author-1',
      username: options.authorUsername ?? 'student.name',
      bot: options.authorIsBot ?? false,
    },
    // Every fake message defaults to no `member` payload — the ordinary
    // REST-fetch shape (MF-D's own module comment, `catch-up.ts`) that made
    // a role-routed course wrongly decide `unrouted` before this scan
    // resolved the real member itself.
    member: null,
    content: options.content ?? '<@bot-1> hello',
    mentions: {
      repliedUser: options.repliedUserId ? { id: options.repliedUserId } : null,
    },
    inGuild: () => true as const,
    reply: vi.fn().mockResolvedValue(undefined),
  }
  return message as unknown as Message<true>
}

/** One fake viewable text channel, whose `.messages.fetch` resolves to whatever `messages` names — the same `Map` shape a real discord.js `Collection` satisfies (`.values()`/`.get()`). */
export function fakeChannel(options: {
  id?: string
  messages?: ReturnType<typeof fakeMessage>[]
  fetchImpl?: () => Promise<Map<string, ReturnType<typeof fakeMessage>>>
}) {
  const id = options.id ?? `channel-${Math.random().toString(36).slice(2)}`
  const collection = new Map(
    (options.messages ?? []).map((message) => [message.id, message])
  )
  const channel = {
    id,
    isTextBased: () => true as const,
    viewable: true,
    messages: {
      fetch: options.fetchImpl
        ? vi.fn(options.fetchImpl)
        : vi.fn().mockResolvedValue(collection),
    },
  }
  return channel as unknown as GuildTextBasedChannel
}

/**
 * One fake guild, holding whatever channels `options.channels` names in its
 * own `channels.cache`. `members.fetch` (MF-D) resolves to
 * `options.member` (defaulting to a plain `fakeGuildMember()` — a real,
 * resolvable member with no roles) unless `options.membersFetchRejects` is
 * set, which simulates the "cannot resolve at all" case (the author left
 * the server, a permission error) instead.
 */
export function fakeGuild(options: {
  id?: string
  channels?: ReturnType<typeof fakeChannel>[]
  member?: ReturnType<typeof fakeGuildMember>
  membersFetchRejects?: boolean
}) {
  const id = options.id ?? 'guild-1'
  const cache = new Map(
    (options.channels ?? []).map((channel) => [channel.id, channel])
  )
  const resolvedMember = options.member ?? fakeGuildMember()
  const guild = {
    id,
    channels: { cache },
    members: {
      fetch: vi.fn(async () => {
        if (options.membersFetchRejects) {
          throw new Error('simulated: member could not be resolved')
        }
        return resolvedMember
      }),
    },
  }
  return guild as unknown as Guild
}

/** One fake ready client, holding whatever guilds `options.guilds` names in its own `guilds.cache`. */
export function fakeReadyClient(options: {
  botId?: string
  botUsername?: string
  guilds?: ReturnType<typeof fakeGuild>[]
}) {
  const cache = new Map(
    (options.guilds ?? []).map((guild) => [guild.id, guild])
  )
  const client = {
    user: {
      id: options.botId ?? 'bot-1',
      username: options.botUsername ?? 'Bloombot',
    },
    guilds: { cache },
    isReady: () => true as const,
  }
  return client as unknown as Client<true>
}
