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

import { CONFIG, getModelPricingTable, loadDotEnv } from '@bloombot/config'
import {
  closeDatabase,
  discordGatewayStatus,
  openDatabase,
  runMigrations,
} from '@bloombot/db'
import { createCountingModelClient } from '@bloombot/core'
import { createAdmissionGate } from '@bloombot/jobs'
import { createLogger } from '@bloombot/logger'
import { createOpenAiModelClient } from '@bloombot/openai'

import { wireCatchUp } from './catch-up.js'
import { startConnectedMarkerHeartbeat } from './connected-marker.js'
import { wireGatewayHealth } from './gateway-health.js'
import { startHealthServer } from './health.js'
import { onMessageCreate } from './message-handler.js'
import { SUPPRESS_ALL_MENTIONS } from './reply-port.js'
import { createShutdown, InFlightTracker } from './shutdown.js'

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

async function main(): Promise<void> {
  // CFG-5: credentials live in `.env`; load it before anything reads CONFIG,
  // which validates the whole environment on first access.
  loadDotEnv()

  // SURF-7 — refuses to start on an environment that does not validate:
  // touching `CONFIG` forces the whole zod schema (LOGS_DIR, DATABASE_PATH,
  // BOT_HEALTH_PORT, ...) to validate before anything else runs, and the two
  // credentials the schema does not cover are checked explicitly right
  // after.
  const logsDir = CONFIG.LOGS_DIR
  const databasePath = CONFIG.DATABASE_PATH
  const healthPort = CONFIG.BOT_HEALTH_PORT
  const admissionLimit = CONFIG.MODEL_ADMISSION_LIMIT
  const admissionWaitMs = CONFIG.MODEL_ADMISSION_WAIT_MS
  // LINK-2 — the panel's own address, read once here (the same "read CONFIG
  // once in main(), thread it through" discipline `admission`/`pricing`
  // already follow below): `@bloombot/discord` itself never reads `CONFIG`.
  // TEN-4 — already normalised (no trailing slash) by `envSchema`'s own
  // `PUBLIC_APP_URL` transform (`packages/config/src/env.ts`), so the
  // connect link this builds can never double a slash the way it could
  // before that normalisation moved into the schema itself.
  const connectUrl = CONFIG.PUBLIC_APP_URL
  // SURF-9 — the same "read CONFIG once in main(), thread it through"
  // discipline every other configured value above already follows:
  // `@bloombot/discord`'s own `decideCatchUp` never reads `CONFIG` either.
  const catchUpBounds = {
    answerMaxAgeMs: CONFIG.DISCORD_CATCHUP_ANSWER_MAX_AGE_MS,
    lookbackMs: CONFIG.DISCORD_CATCHUP_LOOKBACK_MS,
  }
  const botToken = requireEnv('BOT_TOKEN')
  const openaiApiKey = requireEnv('OPENAI_API_KEY')

  const logger = createLogger(PROCESS_NAME, { logsDir })
  const db = openDatabase(databasePath)
  runMigrations(db)

  // COST-5 — wrapped once, here, so every call this process ever makes
  // (including every retry `@bloombot/openai`'s own adapter takes
  // internally, which this wrapper cannot see or double-count — it only
  // observes `ModelClient.ask` itself) is counted; `getModelStats` below
  // hands the running total to the health endpoint.
  const { client: countingModel, getStats: getModelStats } =
    createCountingModelClient(
      createOpenAiModelClient({ apiKey: openaiApiKey, logger })
    )
  const model = countingModel
  // JOB-4 — one gate, shared across every message this process handles;
  // `@bloombot/core`'s own `answerQuestion` applies no bound at all when a
  // caller omits this (its own module comment says why), so building the
  // real, configured one is this process's own job, the same "read CONFIG
  // once in main()" discipline `model` above already follows.
  const admission = createAdmissionGate({
    limit: admissionLimit,
    waitMs: admissionWaitMs,
  })
  // COST-1/COST-6 — the real, configured rate table, the same "read CONFIG
  // once in main(), thread it through" discipline `admission` above already
  // follows: `@bloombot/core` itself never reads `@bloombot/config` (D-29).
  const pricing = getModelPricingTable(CONFIG.MODEL_PRICING_JSON)

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
  const health = await startHealthServer(
    healthPort,
    () => gatewayConnected,
    getModelStats
  )
  // SURF-9 rework round 2, MF-B — the durable "last known connected" marker
  // catch-up's own scan floors its window on (`connected-marker.ts`'s own
  // module comment). Bumped immediately on every genuine connect (here,
  // rather than waiting for the heartbeat's own next tick), kept current by
  // the heartbeat below while connected, and written once more on a clean
  // shutdown, further down.
  wireGatewayHealth(client, (connected) => {
    gatewayConnected = connected
    if (connected) {
      discordGatewayStatus.recordLastKnownConnected(Date.now(), db)
    }
  })
  const connectedMarkerHeartbeat = startConnectedMarkerHeartbeat(
    db,
    () => gatewayConnected
  )

  client.once(Events.ClientReady, (readyClient) => {
    logger.info(
      { botId: readyClient.user.id, botTag: readyClient.user.tag },
      'apps/bot: connected to the Discord gateway'
    )
  })

  // SURF-9 — a fresh gateway session is exactly the moment a message sent
  // while this process was disconnected can finally be found and acted on
  // (`docs/SPEC.md` §32's own incident). `wireCatchUp` (`catch-up.ts`) is
  // what decides *which* event actually means that (SURF-9 rework, MF6) —
  // not this file's own concern beyond passing it what it needs.
  wireCatchUp(client, {
    db,
    model,
    logger,
    admission,
    pricing,
    connectUrl,
    bounds: catchUpBounds,
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
          admission,
          pricing,
          connectUrl,
          catchUpEnabled: catchUpBounds.lookbackMs > 0,
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
    // SURF-9 rework round 2, MF-B — the marker's own clean-shutdown update:
    // if the gateway was actually connected right up to this signal, this
    // is the exact moment catch-up's own window floor should treat as "last
    // known connected" for the *next* restart. Recorded, and the heartbeat
    // stopped, before `shutdown()` below flips `gatewayConnected` false.
    if (gatewayConnected) {
      discordGatewayStatus.recordLastKnownConnected(Date.now(), db)
    }
    connectedMarkerHeartbeat.stop()
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
