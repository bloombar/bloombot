/**
 * Translates one discord.js `messageCreate` event into `@bloombot/discord`'s
 * `InboundMention` + `ReplyPort` and hands it to `handleMention` — the live
 * path's own single entry point, split out of `index.ts` (rather than
 * defined inline there) so it is importable by a test with no `main()`
 * side effects: `index.ts`'s own top level calls `main()` unconditionally on
 * import, which a unit test must never trigger.
 */

import type { Message } from 'discord.js'

import type { ModelClient, PricingTable } from '@bloombot/core'
import { discordHandledMessages, type Database } from '@bloombot/db'
import { handleMention, isHandledOutcome } from '@bloombot/discord'
import type { AdmissionGate } from '@bloombot/jobs'
import type { Logger } from '@bloombot/logger'

import { buildInboundMention } from './inbound.js'
import type { InFlightMessageIds } from './in-flight-messages.js'
import { buildReplyPort } from './reply-port.js'
import { today } from './today.js'

export interface MessageHandlerDeps {
  botId: string
  botDisplayName: string
  db: Database
  model: ModelClient
  logger: Logger
  /** JOB-4's bound on concurrent model calls — built once in `main()`, from `CONFIG`, and shared across every message this process handles. */
  admission: AdmissionGate
  /** COST-1/COST-6's per-model rates — built once in `main()`, from `CONFIG.MODEL_PRICING_JSON`, and shared across every message this process handles. */
  pricing: PricingTable
  /** LINK-2's own address — built once in `main()`, from `CONFIG.PUBLIC_APP_URL`, and shared across every message this process handles. */
  connectUrl: string
  /** SURF-9 rework cheap-fix — `DISCORD_CATCHUP_LOOKBACK_MS <= 0` (`catchUpBounds.lookbackMs`, `main()`). Recording every handled id exists only to dedup against a catch-up scan; with catch-up disabled there is no scan to dedup against, so recording forever would grow the table for no reader ever to use. */
  catchUpEnabled: boolean
  /** SURF-9 follow-up — the same in-process set threaded into `CatchUpDependencies` (`catch-up.ts`); see `in-flight-messages.ts`'s own module comment for why the gateway-hydration double-answer needs it. */
  inFlight: InFlightMessageIds
}

/** Translate one discord.js message into `InboundMention` + `ReplyPort` and hand it to `handleMention`. */
export async function onMessageCreate(
  message: Message,
  deps: MessageHandlerDeps
): Promise<void> {
  // BOT-1's own scope is a server channel — a DM has no category or roles
  // to route by, and `message.inGuild()` is what narrows discord.js's own
  // types (`message.channel`, `message.guild`) to their guild-only shape.
  if (!message.inGuild()) return

  // SURF-9 follow-up — claimed *before* `handleMention` ever runs, so a
  // catch-up scan whose own fetch races this exact message (the
  // gateway-hydration window `in-flight-messages.ts`'s own module comment
  // describes) sees it as already spoken for, not merely absent from
  // `discord_handled_messages` yet. Removed in `finally`, below, only after
  // the durable record has actually been written — never a moment where the
  // id is in neither the set nor the table.
  deps.inFlight.add(message.id)
  try {
    const input = buildInboundMention(message, deps.botId)
    const reply = buildReplyPort(message)

    const result = await handleMention(input, {
      db: deps.db,
      model: deps.model,
      logger: deps.logger,
      reply,
      day: today(),
      botDisplayName: deps.botDisplayName,
      admission: deps.admission,
      pricing: deps.pricing,
      connectUrl: deps.connectUrl,
    })

    // SURF-9 — recorded *after* `handleMention` returns, for every outcome
    // that actually reached this message's own handling (`isHandledOutcome`,
    // shared with the catch-up path so the two never drift on which outcomes
    // count): a crash mid-answer leaves the id unrecorded, so the next
    // catch-up scan re-handles it rather than this message being silently
    // lost the way `docs/SPEC.md` §32's own incident describes.
    if (deps.catchUpEnabled && isHandledOutcome(result.kind)) {
      discordHandledMessages.recordHandledMessage(
        {
          messageId: message.id,
          serverId: message.guildId,
          channelId: message.channelId,
          handledAt: Date.now(),
        },
        deps.db
      )
    }

    deps.logger.debug({ result }, 'apps/bot: handled an incoming message')
  } finally {
    deps.inFlight.delete(message.id)
  }
}
