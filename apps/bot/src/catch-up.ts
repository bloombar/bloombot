/**
 * SURF-9 — the discord.js half of catching up on messages missed while this
 * process was disconnected. `packages/discord/src/catch-up.ts`'s own
 * `decideCatchUp` is the whole policy (pure, no discord.js in sight); this
 * file is only the wiring around it — fetching candidate messages, handing
 * each to `decideCatchUp`, and dispatching whatever it decides. Run on every
 * fresh gateway session (`wireCatchUp`, below), after the process is already
 * wired to serve live messages. See `docs/DECISIONS.md` D-100 for the fuller
 * reasoning behind several of the choices below.
 *
 * **The scan window (SURF-9 rework round 2, MF-B/MF-C).** The floor is
 * `discord_gateway_status`'s own single row — the last moment this process
 * is *known* to have been connected (`apps/bot`'s own `connected-marker.ts`),
 * capped below by `DISCORD_CATCHUP_LOOKBACK_MS` as a hard ceiling on how far
 * back the floor may reach. The window's own upper bound is `sessionStart` —
 * the moment this very scan began: a message created at or after that
 * instant is a candidate the live path (`Events.MessageCreate`, already
 * wired before this scan ever runs) will handle on its own, so including it
 * here too would answer it twice. An empty marker (a fresh migration, most
 * often, or a database this process has genuinely never connected against
 * before) means there is no known baseline to catch up from, so this scans
 * nothing at all rather than guessing the full lookback.
 *
 * **The fetch (SURF-9 rework round 1, MF1).** `channel.messages.fetch({ limit: 100 })`
 * with no `after`/`before` returns the *newest* 100 messages in the channel
 * — exactly what "one page, no pagination" should mean for recovering what
 * was *just* missed. `after: <cutoff>` returns the *oldest* 100 messages
 * since the cutoff instead, which in any channel busier than 100 messages
 * per lookback window never even reaches the message this scan exists to
 * recover. The window itself is applied by filtering the fetched page
 * locally, not by asking Discord's own `after` cursor for it.
 *
 * **The author's guild member (SURF-9 rework round 2, MF-D).** A REST fetch
 * carries no `member` payload — `message.member` is `null` for any author
 * outside the gateway's own member cache, which is routine above 50
 * members — so this resolves the real member explicitly
 * (`guild.members.fetch`, cached by discord.js) before building the mention.
 * A message whose member cannot be resolved is skipped *without being
 * recorded*, so a later scan can still retry it: recording it here would
 * bury it permanently the moment a role-routed course reads an empty role
 * list and decides `unrouted` — which itself still counts as "handled"
 * (`isHandledOutcome`), the exact failure mode this guards against.
 *
 * Bounded and non-fatal throughout: a permission error, a rate limit, or a
 * deleted channel on one channel is logged and skipped, never allowed to
 * take the rest of the scan — or the process — down with it.
 */

import {
  Events,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type GuildTextBasedChannel,
} from 'discord.js'

import type { ModelClient, PricingTable } from '@bloombot/core'
import {
  discordGatewayStatus,
  discordHandledMessages,
  discordServers,
  type Database,
} from '@bloombot/db'
import {
  catchUpApologyText,
  decideCatchUp,
  handleMention,
  isHandledOutcome,
  wouldRouteToAnEnabledCourse,
  type CatchUpBounds,
  type CatchUpCandidate,
} from '@bloombot/discord'
import type { AdmissionGate } from '@bloombot/jobs'
import type { Logger } from '@bloombot/logger'

import { buildInboundMention } from './inbound.js'
import { buildReplyPort } from './reply-port.js'
import { today } from './today.js'

/** What `runCatchUp` needs beyond the ready client itself — the same shape `MessageHandlerDeps` (`index.ts`) already takes, plus the two configured bounds. */
export interface CatchUpDependencies {
  botId: string
  botDisplayName: string
  db: Database
  model: ModelClient
  logger: Logger
  admission: AdmissionGate
  pricing: PricingTable
  connectUrl: string
  bounds: CatchUpBounds
}

/** Every text-based channel in `guild` the bot can currently view — a category, a voice channel, or one this account cannot see is never a candidate. */
export function listViewableTextChannels(
  guild: Guild
): GuildTextBasedChannel[] {
  const channels: GuildTextBasedChannel[] = []
  for (const channel of guild.channels.cache.values()) {
    if (!isViewableTextChannel(channel)) continue
    channels.push(channel)
  }
  return channels
}

function isViewableTextChannel(
  channel: GuildBasedChannel
): channel is GuildTextBasedChannel {
  return channel.isTextBased() && channel.viewable
}

/**
 * SURF-9 rework round 2, MF-D — resolve the message author's real
 * `GuildMember`, for a channel whose `guild` this belongs to. `message.member`
 * is read first (free, no request, and already correct whenever discord.js
 * happens to have the author cached); `guild.members.fetch` only runs when
 * that is `null` — the ordinary case for a REST-fetched message whose
 * author is outside the gateway's own member cache. `undefined` means the
 * member could not be resolved at all (they left the server, a permission
 * error, ...) — the caller's own job to decide what that means, not this
 * function's.
 */
async function resolveAuthorMember(
  message: { member: GuildMember | null; author: { id: string } },
  guild: Guild
): Promise<GuildMember | undefined> {
  if (message.member) return message.member
  try {
    return await guild.members.fetch(message.author.id)
  } catch {
    return undefined
  }
}

/** `wireCatchUp`'s own dependencies — everything `CatchUpDependencies` needs except `botId`/`botDisplayName`, which it reads fresh from the ready client itself on every fresh session, rather than a caller capturing them once before the client has necessarily logged in. */
export type CatchUpWiringDependencies = Omit<
  CatchUpDependencies,
  'botId' | 'botDisplayName'
>

/**
 * SURF-9 rework round 2, MF-A — wires `runCatchUp` to *both*
 * `Events.ShardReady` and `Events.ClientReady`, guarded by one shared
 * in-flight flag so the two can never start two overlapping scans for the
 * same session.
 *
 * The previous round wired `Events.ShardReady` alone, gated on
 * `client.isReady()` — which is exactly the bug: discord.js emits
 * `Events.ShardReady` from its own `AllReady` handling *before*
 * `checkShardsReady()`/`triggerClientReady()` ever runs, and
 * `triggerClientReady()` is the only place `ws.status` becomes
 * `Status.Ready` (`WebSocketManager.js`), which is what `Client#isReady()`
 * actually checks. So on a cold process start, `isReady()` is still `false`
 * the moment `ShardReady` fires, the guard returned early, and the scan this
 * requirement exists for — the one on the very deploy restart that caused
 * the outage — never ran at all. It only ever ran on a *later* re-identify,
 * by which point `isReady()` had caught up from the first connection.
 *
 * The fix reads `client.user` directly instead: a fresh `READY` payload
 * populates it before either event fires, so it is the reliable "this
 * client actually knows who it is" signal `isReady()` was standing in for,
 * without inheriting its timing bug. `Events.ClientReady` is wired too —
 * belt and braces for whatever shard topology this process ends up running
 * under — and the in-flight guard means a session where both happen to fire
 * (the ordinary case, moments apart, on a cold start) still only ever scans
 * once for it.
 *
 * Deliberately *not* wired to `Events.ShardResume`: a resumed session is one
 * Discord itself replays the events missed during the gap for
 * (`shardResume`'s own `replayedEvents` count), so nothing was actually
 * missed there for a scan to find.
 */
export function wireCatchUp(
  client: Client,
  deps: CatchUpWiringDependencies
): void {
  let scanInFlight = false

  const triggerScan = (
    source: 'shardReady' | 'clientReady',
    shardId?: number
  ) => {
    const user = client.user
    if (!user) {
      // A genuinely broken client state, not the ordinary "not ready yet"
      // `isReady()` used to (wrongly) guard against — `client.user` is
      // populated before either event this function wires ever fires.
      deps.logger.error(
        { source, shardId },
        'apps/bot: catch-up scan skipped — client.user was unset on a ready event'
      )
      return
    }
    if (scanInFlight) return
    scanInFlight = true

    // Never awaited: `runCatchUp` itself never throws (its own doc
    // comment), so nothing about this can block or fail the caller.
    void runCatchUp(client as Client<true>, {
      ...deps,
      botId: user.id,
      botDisplayName: user.username,
    })
      .catch((error: unknown) => {
        // Belt and braces beside `runCatchUp`'s own internal try/catch —
        // this is the one place nothing must ever throw out of, a gateway
        // event handler.
        deps.logger.error(
          { err: error, source, shardId },
          'apps/bot: catch-up scan failed to run'
        )
      })
      .finally(() => {
        scanInFlight = false
      })
  }

  client.on(Events.ShardReady, (shardId) => triggerScan('shardReady', shardId))
  client.once(Events.ClientReady, () => triggerScan('clientReady'))
}

/**
 * Scan every text channel of every actively-bound Discord server for
 * messages this process never handled, and dispatch each: `answer` runs the
 * same `handleMention` call the live path makes; `apologise` sends the short
 * apology, but only where routing agrees an answer could actually have
 * happened live (MF4); `skip` does nothing. Logs one summary line at the end
 * (channels scanned, answered, apologised, skipped) — the next incident is
 * one `grep` away rather than invisible.
 *
 * Never throws — every failure below this function's own top level (a
 * missing guild, a channel fetch that rejects) is caught, logged, and
 * skipped, so a single misbehaving channel cannot stop the rest of the scan,
 * and this function itself cannot take its caller down with it.
 */
export async function runCatchUp(
  client: Client<true>,
  deps: CatchUpDependencies
): Promise<void> {
  const { db, bounds, logger } = deps
  // SURF-9 rework round 2, MF-C — captured once, at the top: the moment this
  // scan began is also its own window's upper bound (below) and the `now`
  // `decideCatchUp` ages every candidate against.
  const sessionStart = Date.now()

  // `DISCORD_CATCHUP_LOOKBACK_MS <= 0` disables catch-up completely — no
  // fetch, no dispatch. The live path (`index.ts`) already stops recording
  // handled ids in this case (nothing left to dedup against), so the prune
  // below is a one-time drain of whatever the table already held before
  // catch-up was turned off, not an ongoing sweep — cutting at `sessionStart`
  // (not `sessionStart - bounds.lookbackMs`, which is not a real bound here)
  // clears every existing row.
  if (bounds.lookbackMs <= 0) {
    discordHandledMessages.pruneHandledMessagesOlderThan(sessionStart, db)
    logger.info(
      'apps/bot: catch-up scan disabled (DISCORD_CATCHUP_LOOKBACK_MS=0)'
    )
    return
  }

  // SURF-9 rework round 2, MF-B — the window's own floor is the last moment
  // this process is *known* to have been connected (`discord_gateway_status`,
  // never pruned — see this file's own module comment for why
  // `discord_handled_messages` could not serve this purpose), capped by the
  // lookback ceiling; no marker recorded yet means no known baseline, so
  // this scans nothing.
  const lastKnownConnectedAt = discordGatewayStatus.getLastKnownConnectedAt(db)
  if (lastKnownConnectedAt === undefined) {
    logger.info(
      'apps/bot: catch-up scan skipped — no last-known-connected marker recorded yet (cold start)'
    )
    return
  }
  const hardCeiling = sessionStart - bounds.lookbackMs
  const windowStart = Math.max(lastKnownConnectedAt, hardCeiling)

  // Prune to the hard ceiling, not the (tighter) window floor — a row this
  // scan does not need *this run* may still be within the configured
  // lookback and worth keeping for a later one. This bounds
  // `discord_handled_messages`'s own growth only; it has no bearing on the
  // window floor above any more (MF-B).
  discordHandledMessages.pruneHandledMessagesOlderThan(hardCeiling, db)
  const handledIds = discordHandledMessages.listHandledMessageIds(db)

  let channelsScanned = 0
  let answered = 0
  let apologised = 0
  let skipped = 0

  const bindings = discordServers.listActiveDiscordServerBindings(db)
  for (const binding of bindings) {
    const guild = client.guilds.cache.get(binding.serverId)
    if (!guild) {
      // The bot's own gateway cache has not (yet, or ever) seen this guild —
      // nothing to scan; the live path will still answer once it does.
      continue
    }

    for (const channel of listViewableTextChannels(guild)) {
      channelsScanned += 1
      try {
        // MF1 — the newest page, not the oldest one since the cutoff; see
        // this file's own module comment.
        const fetched = await channel.messages.fetch({ limit: 100 })

        const candidates: CatchUpCandidate[] = []
        for (const message of fetched.values()) {
          if (!message.inGuild()) continue // cannot happen for a guild channel's own fetch, guarded rather than assumed
          if (message.createdTimestamp < windowStart) continue // outside this run's own window floor
          if (message.createdTimestamp >= sessionStart) continue // MF-C — the live path already owns this one
          const member = await resolveAuthorMember(message, guild)
          if (!member) {
            // MF-D — cannot resolve the author's guild member: skip
            // *without recording*, so a later scan can retry it, rather
            // than risk a role-routed course reading an empty role list and
            // burying this message permanently as `unrouted`.
            skipped += 1
            continue
          }
          candidates.push({
            messageId: message.id,
            createdAt: message.createdTimestamp,
            mention: buildInboundMention(message, deps.botId, member),
          })
        }

        const decisions = decideCatchUp(
          candidates,
          handledIds,
          sessionStart,
          bounds
        )
        for (const decision of decisions) {
          if (decision.kind === 'skip') {
            skipped += 1
            continue
          }

          const message = fetched.get(decision.candidate.messageId)
          if (!message || !message.inGuild()) continue // the message this decision was built from must still be the one just fetched

          // SURF-9 rework round 1, MF3 — re-checked immediately before
          // dispatch. The `handledIds` snapshot above is taken once per run,
          // before any channel is even fetched, and the live path keeps
          // serving messages the whole time this scan runs — a student
          // re-sending the same question after noticing the outage, most
          // often, is answered live before this loop ever reaches their
          // earlier message. This is the check that actually stops the
          // double answer; the snapshot alone cannot.
          if (discordHandledMessages.isMessageHandled(message.id, db)) {
            skipped += 1
            continue
          }

          const reply = buildReplyPort(message)

          if (decision.kind === 'apologise') {
            // SURF-9 rework round 1, MF4 — an apology only where an answer
            // could actually have happened live: the same silence
            // SURF-6/SURF-8 already give a message matching no course, one
            // ambiguous between two, or one whose only matching course is
            // disabled (`wouldRouteToAnEnabledCourse` covers all three —
            // see its own doc comment) is what this gets too, not an
            // apology posted beneath nothing the live path would ever have
            // said.
            if (!wouldRouteToAnEnabledCourse(decision.candidate.mention, db)) {
              skipped += 1
              continue
            }
            await reply.reply(catchUpApologyText())
            discordHandledMessages.recordHandledMessage(
              {
                messageId: message.id,
                serverId: guild.id,
                channelId: channel.id,
                handledAt: Date.now(),
              },
              db
            )
            handledIds.add(message.id)
            apologised += 1
            continue
          }

          // `decision.kind === 'answer'` — the same call the live path makes
          // (`index.ts`'s own `onMessageCreate`).
          const result = await handleMention(decision.candidate.mention, {
            db,
            model: deps.model,
            logger: deps.logger,
            reply,
            day: today(),
            botDisplayName: deps.botDisplayName,
            admission: deps.admission,
            pricing: deps.pricing,
            connectUrl: deps.connectUrl,
          })
          // Recorded *after* `handleMention` returns, the same "a crash
          // mid-answer re-handles rather than silently loses it" discipline
          // `discord-handled-messages.ts`'s own doc comment holds itself to.
          if (isHandledOutcome(result.kind)) {
            discordHandledMessages.recordHandledMessage(
              {
                messageId: message.id,
                serverId: guild.id,
                channelId: channel.id,
                handledAt: Date.now(),
              },
              db
            )
            handledIds.add(message.id)
            // Cheap-fix — `unrouted`/`course-disabled` are the two silent
            // outcomes (SURF-6/SURF-8: nothing was sent to the channel at
            // all), so counting them as `answered` would make this run's
            // own summary line claim answers that never happened — exactly
            // the number an operator greps this log line for after an
            // incident.
            if (
              result.kind === 'unrouted' ||
              result.kind === 'course-disabled'
            ) {
              skipped += 1
            } else {
              answered += 1
            }
          } else {
            skipped += 1
          }
        }
      } catch (error) {
        // A permission error, a rate limit, a channel deleted mid-scan — log
        // and move on to the next channel, never let one channel take the
        // rest of the scan down.
        logger.error(
          { err: error, guildId: guild.id, channelId: channel.id },
          'apps/bot: catch-up scan failed for a channel, continuing'
        )
      }
    }
  }

  logger.info(
    { channelsScanned, answered, apologised, skipped },
    'apps/bot: catch-up scan complete'
  )
}
