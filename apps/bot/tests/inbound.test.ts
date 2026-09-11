/**
 * `buildInboundMention` — translating a discord.js message into
 * `@bloombot/discord`'s DTO, exercised against plain fakes shaped like the
 * handful of discord.js properties it actually reads, not a real `Message`.
 *
 * Finding 6 of the SURF-1 rework: a thread's own `.parent` is the parent
 * *channel*, not the category. Finding 3: a Discord Reply carries no
 * `<@id>` token, so `repliesToBot` is read from `message.mentions.repliedUser`
 * instead of the message text.
 */

import { describe, expect, it } from 'vitest'

import type { InboundMention } from '@bloombot/discord'

import { buildInboundMention } from '../src/inbound.js'

const BOT_ID = 'bot-snowflake-1'

/** A fake category — all `resolveCategoryName` ever reads off one is its `name`. */
function fakeCategory(name: string) {
  return { name }
}

/** A fake non-thread channel: its own category is one level up, through `.parent`. */
function fakeChannel(
  options: {
    name?: string
    categoryName?: string | null
  } = {}
) {
  return {
    name: options.name ?? 'general',
    isThread: () => false as const,
    parent:
      options.categoryName === undefined
        ? null
        : options.categoryName === null
          ? null
          : fakeCategory(options.categoryName),
  }
}

/** A fake thread: its own `.parent` is the parent channel, whose own `.parent` is the category. */
function fakeThreadChannel(
  options: {
    name?: string
    categoryName?: string | null
  } = {}
) {
  return {
    name: options.name ?? 'help-thread',
    isThread: () => true as const,
    parent: {
      name: 'parent-channel',
      parent:
        options.categoryName === undefined || options.categoryName === null
          ? null
          : fakeCategory(options.categoryName),
    },
  }
}

function fakeMessage(options: {
  channel?:
    ReturnType<typeof fakeChannel> | ReturnType<typeof fakeThreadChannel>
  guildId?: string
  authorId?: string
  authorUsername?: string
  authorIsBot?: boolean
  memberDisplayName?: string | null
  roleNames?: string[]
  content?: string
  repliedUserId?: string | null
}) {
  return {
    guild: { id: options.guildId ?? 'guild-1' },
    channel: options.channel ?? fakeChannel(),
    author: {
      id: options.authorId ?? 'author-1',
      username: options.authorUsername ?? 'student.name',
      bot: options.authorIsBot ?? false,
    },
    member:
      options.memberDisplayName == null
        ? null
        : {
            displayName: options.memberDisplayName,
            roles: {
              cache: {
                map: (fn: (role: { name: string }) => string) =>
                  (options.roleNames ?? []).map((name) => fn({ name })),
              },
            },
          },
    content: options.content ?? `<@${BOT_ID}> hello`,
    mentions: {
      repliedUser: options.repliedUserId ? { id: options.repliedUserId } : null,
    },
    // `buildInboundMention`'s parameter type is a real discord.js `Message<true>`
    // — this fake only carries what it actually reads off one, cast the same
    // way `packages/discord/tests/helpers/fake-logger.ts` casts a fake pino
    // `Logger`.
  } as unknown as Parameters<typeof buildInboundMention>[0]
}

/** A fake `GuildMember` — the same shape `fakeMessage`'s own inline `member` already takes, factored out so the MF-D tests below can build one independent of a message. */
function fakeGuildMember(options: {
  displayName?: string
  roleNames?: string[]
}) {
  return {
    displayName: options.displayName ?? 'Explicit Member',
    roles: {
      cache: {
        map: (fn: (role: { name: string }) => string) =>
          (options.roleNames ?? []).map((name) => fn({ name })),
      },
    },
  } as unknown as Parameters<typeof buildInboundMention>[2]
}

describe('buildInboundMention', () => {
  it('reads the category through a non-thread channel one level up, as before', () => {
    const message = fakeMessage({
      channel: fakeChannel({ name: 'general', categoryName: 'Web Design' }),
    })

    const result = buildInboundMention(message, BOT_ID)

    expect(result.categoryName).toBe('Web Design')
    expect(result.channelName).toBe('general')
  })

  it('is null for an uncategorized non-thread channel', () => {
    const message = fakeMessage({
      channel: fakeChannel({ categoryName: null }),
    })

    expect(buildInboundMention(message, BOT_ID).categoryName).toBeNull()
  })

  // Finding 6 — the bug this test exists to catch: reading `channel.parent`
  // directly on a thread gives the parent *channel*, not the category.
  it('resolves the category through a thread — one level further up than a non-thread channel', () => {
    const message = fakeMessage({
      channel: fakeThreadChannel({
        name: 'help-thread',
        categoryName: 'Web Design',
      }),
    })

    const result = buildInboundMention(message, BOT_ID)

    expect(result.categoryName).toBe('Web Design')
    expect(result.channelName).toBe('help-thread')
  })

  it('is null for a thread whose parent channel is itself uncategorized', () => {
    const message = fakeMessage({
      channel: fakeThreadChannel({ categoryName: null }),
    })

    expect(buildInboundMention(message, BOT_ID).categoryName).toBeNull()
  })

  it('resolves the display name from the member nickname, falling back to the username', () => {
    const withNickname = fakeMessage({ memberDisplayName: 'Nickname' })
    const withoutMember = fakeMessage({
      memberDisplayName: null,
      authorUsername: 'bare.username',
    })

    expect(buildInboundMention(withNickname, BOT_ID).authorDisplayName).toBe(
      'Nickname'
    )
    expect(buildInboundMention(withoutMember, BOT_ID).authorDisplayName).toBe(
      'bare.username'
    )
  })

  // Finding 3 — `repliesToBot` is read from Discord's own reply
  // relationship, not from the message text.
  it('sets repliesToBot from message.mentions.repliedUser, independent of the text', () => {
    const reply = fakeMessage({
      repliedUserId: BOT_ID,
      content: 'and the final?',
    })
    const notAReply = fakeMessage({
      repliedUserId: null,
      content: 'and the final?',
    })
    const replyToSomeoneElse = fakeMessage({
      repliedUserId: 'someone-else',
      content: 'and the final?',
    })

    expect(buildInboundMention(reply, BOT_ID).repliesToBot).toBe(true)
    expect(buildInboundMention(notAReply, BOT_ID).repliesToBot).toBe(false)
    expect(buildInboundMention(replyToSomeoneElse, BOT_ID).repliesToBot).toBe(
      false
    )
  })

  it('carries the rest of the DTO through unchanged', () => {
    const message = fakeMessage({
      guildId: 'guild-42',
      authorId: 'author-42',
      content: `<@${BOT_ID}> when is the midterm?`,
      memberDisplayName: 'Some Student',
      roleNames: ['admins-wd', 'students-wd'],
      authorIsBot: true,
    })

    const result: InboundMention = buildInboundMention(message, BOT_ID)

    expect(result.guildId).toBe('guild-42')
    expect(result.authorId).toBe('author-42')
    expect(result.text).toBe(`<@${BOT_ID}> when is the midterm?`)
    expect(result.authorRoleNames).toEqual(['admins-wd', 'students-wd'])
    expect(result.botId).toBe(BOT_ID)
    expect(result.authorIsBot).toBe(true)
  })

  // SURF-9 rework round 2, MF-D — a REST-fetched message carries no
  // `message.member` at all; `catch-up.ts` resolves the real member itself
  // and passes it as the third argument, which must win over whatever
  // `message.member` says (here, nothing).
  describe('the explicit member override (MF-D)', () => {
    it('reads the display name and role names from the explicit member when message.member is null', () => {
      const message = fakeMessage({ memberDisplayName: null })
      const member = fakeGuildMember({
        displayName: 'Resolved Member',
        roleNames: ['admins-wd', 'students-wd'],
      })

      const result = buildInboundMention(message, BOT_ID, member)

      expect(result.authorDisplayName).toBe('Resolved Member')
      expect(result.authorRoleNames).toEqual(['admins-wd', 'students-wd'])
    })

    it('still falls back to the username when neither message.member nor an explicit member is available', () => {
      const message = fakeMessage({
        memberDisplayName: null,
        authorUsername: 'bare.username',
      })

      const result = buildInboundMention(message, BOT_ID, null)

      expect(result.authorDisplayName).toBe('bare.username')
      expect(result.authorRoleNames).toEqual([])
    })

    it("defaults to message.member when no third argument is passed at all — the live path's own call is unaffected", () => {
      const message = fakeMessage({
        memberDisplayName: 'Live Gateway Member',
        roleNames: ['students-wd'],
      })

      const result = buildInboundMention(message, BOT_ID)

      expect(result.authorDisplayName).toBe('Live Gateway Member')
      expect(result.authorRoleNames).toEqual(['students-wd'])
    })
  })
})
