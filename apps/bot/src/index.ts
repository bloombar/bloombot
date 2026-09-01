/**
 * apps/bot — the Discord bot process (SURF-1..7, PLAT-3, PLAT-4).
 *
 * The only process in the platform that holds a Discord gateway connection
 * (PLAT-3): the API and worker reach Discord over REST with the same token,
 * so nothing here has to coordinate with another process over who owns the
 * session. Single-instance by design (PLAT-4) — a second copy of this
 * process on the same token is an operator error, not redundancy.
 *
 * Thin on purpose (per this slice's own brief): everything worth unit
 * testing — binding lookup, person resolution, routing, mention rewriting,
 * splitting, rendering every `AnswerResult` — lives in `@bloombot/discord`'s
 * `handleMention`, tested there with no discord.js in the loop. This file's
 * own job is translating discord.js's own events into `@bloombot/discord`'s
 * `InboundMention` DTO and `ReplyPort` (`inbound.ts`, `reply-port.ts`),
 * which is also why it is the one place in the platform allowed to import
 * discord.js at all — enforced by `packages/discord/tests/no-vendor-sdk.test.ts`,
 * not merely documented here. The handful of other concerns this process
 * itself owns — the health flag's own lifecycle, the local day boundary, and
 * a shutdown that drains cleanly — are each split into their own small,
 * discord.js-light module (`gateway-health.ts`, `today.ts`, `shutdown.ts`),
 * the same way `health.ts` already stood on its own, so each is testable
 * without a real gateway connection.
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type OmitPartialGroupDMChannel,
} from 'discord.js'

import { CONFIG } from '@bloombot/config'
import {
  closeDatabase,
  openDatabase,
  runMigrations,
  type Database,
} from '@bloombot/db'
import type { ModelClient } from '@bloombot/core'
import { handleMention } from '@bloombot/discord'
import { createLogger, type Logger } from '@bloombot/logger'
import { createOpenAiModelClient } from '@bloombot/openai'

import { wireGatewayHealth } from './gateway-health.js'
import { startHealthServer } from './health.js'
import { buildInboundMention } from './inbound.js'
import { buildReplyPort, SUPPRESS_ALL_MENTIONS } from './reply-port.js'
import { createShutdown, InFlightTracker } from './shutdown.js'
import { today } from './today.js'

const PROCESS_NAME = 'bot'

/**
 * SURF-7 — a credential this process needs that `@bloombot/config`'s schema
 * does not (yet) cover: `BOT_TOKEN` and `OPENAI_API_KEY` are, per CFG-5,
 * "credentials [that] live only in a .env file loaded by every entry
 * point" — read directly here, rather than widening the shared schema for
 * this slice, and checked explicitly so a missing one fails at startup with
 * a clear message instead of the first time a student's message arrives.
 */
function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`apps/bot: ${name} must be set (see env.example)`)
  }
  return value
}

interface MessageHandlerDeps {
  botId: string
  botDisplayName: string
  db: Database
  model: ModelClient
  logger: Logger
}

/** Translate one discord.js message into `InboundMention` + `ReplyPort` and hand it to `handleMention`. */
async function onMessageCreate(
  message: Message,
  deps: MessageHandlerDeps
): Promise<void> {
  // BOT-1's own scope is a server channel — a DM has no category or roles
  // to route by, and `message.inGuild()` is what narrows discord.js's own
  // types (`message.channel`, `message.guild`) to their guild-only shape.
  if (!message.inGuild()) return

  const input = buildInboundMention(message, deps.botId)
  const reply = buildReplyPort(message)

  const result = await handleMention(input, {
    db: deps.db,
    model: deps.model,
    logger: deps.logger,
    reply,
    day: today(),
    botDisplayName: deps.botDisplayName,
  })

  deps.logger.debug({ result }, 'apps/bot: handled an incoming message')
}

async function main(): Promise<void> {
  // SURF-7 — refuses to start on an environment that does not validate:
  // touching `CONFIG` forces the whole zod schema (LOGS_DIR, DATABASE_PATH,
  // BOT_HEALTH_PORT, ...) to validate before anything else runs, and the two
  // credentials the schema does not cover are checked explicitly right
  // after.
  const logsDir = CONFIG.LOGS_DIR
  const databasePath = CONFIG.DATABASE_PATH
  const healthPort = CONFIG.BOT_HEALTH_PORT
  const botToken = requireEnv('BOT_TOKEN')
  const openaiApiKey = requireEnv('OPENAI_API_KEY')

  const logger = createLogger(PROCESS_NAME, { logsDir })
  const db = openDatabase(databasePath)
  runMigrations(db)

  const model = createOpenAiModelClient({ apiKey: openaiApiKey, logger })

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      // Requires the "Server Members Intent" privileged intent enabled in
      // the Discord developer portal (env.example's own note) — the same
      // intent `discord_manager.py:80` requests.
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      // Requires the "Message Content Intent" privileged intent — without
      // it Discord withholds `message.content` from every event, and BOT-1
      // has nothing to check a mention against.
      GatewayIntentBits.MessageContent,
    ],
    // Finding 1 of this slice's rework — the client-level default, so a
    // reply built anywhere other than `reply-port.ts`'s `buildReplyPort`
    // (which sets the same value again, deliberately redundant) still
    // cannot ping anyone by accident. See `docs/DECISIONS.md` D-17.
    allowedMentions: SUPPRESS_ALL_MENTIONS,
  })

  // SURF-7 — what the health endpoint reports: only this, read fresh on
  // every request by `startHealthServer`, never cached at the moment it
  // last changed. Finding 4 — wired to the gateway's full lifecycle
  // (`gateway-health.ts`), not just latched `true` on the first `ClientReady`.
  let gatewayConnected = false
  const health = await startHealthServer(healthPort, () => gatewayConnected)
  wireGatewayHealth(client, (connected) => {
    gatewayConnected = connected
  })

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(
      { botId: readyClient.user.id, botTag: readyClient.user.tag },
      'apps/bot: connected to the Discord gateway'
    )
  })

  client.on(Events.Error, (error) => {
    logger.error({ err: error }, 'apps/bot: gateway error')
  })

  // Finding 7 — every in-flight handler is tracked here so shutdown can wait
  // for it (bounded) instead of abandoning it mid-answer.
  const inFlight = new InFlightTracker()

  client.on(
    Events.MessageCreate,
    (message: OmitPartialGroupDMChannel<Message>) => {
      const botId = client.user?.id
      if (!botId) return // not logged in yet — cannot happen once Events.ClientReady has fired, guarded rather than assumed
      inFlight.track(
        onMessageCreate(message, {
          botId,
          botDisplayName: client.user?.username ?? 'Bloombot',
          db,
          model,
          logger,
        }).catch((error: unknown) => {
          logger.error(
            { err: error },
            'apps/bot: failed to handle an incoming message'
          )
        })
      )
    }
  )

  // SURF-7 — closes the gateway and the database rather than leaving the
  // socket to time out; the health server stops too, so a supervisor
  // watching it sees this process actually go away instead of reporting
  // stale health after the process has already exited. Finding 7:
  // `createShutdown` (`shutdown.ts`) awaits the close handshake, drains
  // in-flight handlers first (bounded), and makes a second signal a no-op
  // rather than a second teardown racing the first.
  const shutdown = createShutdown({
    logger,
    setDisconnected: () => {
      gatewayConnected = false
    },
    destroyClient: () => client.destroy(),
    closeDb: () => closeDatabase(db),
    closeHealth: () => health.close(),
    inFlight,
  })
  const onSignal = (signal: string) => {
    void shutdown(signal).then(() => process.exit(0))
  }
  process.once('SIGINT', () => onSignal('SIGINT'))
  process.once('SIGTERM', () => onSignal('SIGTERM'))

  await client.login(botToken)
}

main().catch((error: unknown) => {
  // No logger may exist yet if `main` failed before `createLogger` ran (a
  // bad environment, SURF-7) — stderr is the only sink guaranteed to work.
  console.error('apps/bot: failed to start', error)
  process.exit(1)
})
