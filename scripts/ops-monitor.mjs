/**
 * OPS-12 — notices a student-facing failure and pages an operator, rather
 * than leaving "an instructor reports it" as the only way anyone finds out.
 *
 * COST-5 already made every process's own health observable — the gateway
 * connection, the queue depth, the model provider's own running error rate
 * — through the `/health` endpoints `scripts/health-check.mjs` polls. This
 * script is what turns that observability into a notice: it polls the same
 * four endpoints on an interval, and sends a notification on every
 * *transition* — healthy to unhealthy, and back — rather than once per
 * poll, so a sustained outage produces one page, not one every
 * `OPS_ALERT_POLL_INTERVAL_MS`.
 *
 * "Unhealthy" is not only "not `200`". `apps/bot`'s own `/health` reports
 * `200` for as long as the gateway is connected, whether or not the model
 * provider behind it is actually answering (`health.ts`'s own module
 * comment: it "deliberately reports nothing else" at the HTTP-status
 * level) — a provider outage is real in COST-5's own list of things this
 * requirement must notice ("gateway lost, provider failing, database
 * unreachable"), so `evaluate` below reads the same `model.errorRate`
 * number `apps/bot`'s health body already carries and treats a sustained
 * high error rate as unhealthy too, even while the gateway itself is fine.
 *
 * Notification is a plain HTTP POST to `OPS_ALERT_WEBHOOK_URL` — Discord's
 * and Slack's own incoming-webhook formats both accept a JSON body with a
 * `content`/`text` string and ignore keys they do not recognize, so one
 * POST works with either without a vendor SDK, and without standing up any
 * new service: an operator creates one incoming webhook (Discord: a text
 * channel's own Integrations settings; Slack: an app's Incoming Webhooks
 * feature) and sets the URL it hands back. When no webhook is configured,
 * the notification still happens: it is written to this process's own
 * stdout/stderr, which pm2 (OPS-2) already redirects to
 * `logs/ops-monitor.log` — degraded, not silent, the same "found out from
 * logs, not an invoice" shape `apps/api`'s own `logging-email-sender.ts`
 * uses for an equivalent gap (no real mail transport configured yet).
 *
 * Deliberately dependency-free from the workspace's own TypeScript
 * packages, the same reason `scripts/health-check.mjs`'s own module
 * comment gives — this keeps `npm run dev`-style tooling usable without a
 * prior build, even though this particular script only ever runs under pm2
 * in production; consistency with `health-check.mjs`, which it imports
 * directly, matters more than the marginal convenience `@bloombot/config`
 * would add here.
 */

import { checkAll, healthEndpoints } from './health-check.mjs'

/** How often to poll, in milliseconds — configurable so a noisy environment can back off without a code change. */
export const DEFAULT_POLL_INTERVAL_MS = 30_000

/**
 * A process is treated as degraded by model errors only once it has made
 * enough calls that the rate means something — `errorRate` on a single
 * failed call out of one is `1`, and would page on the very first retry a
 * transient network blip causes.
 */
const MODEL_ERROR_MIN_CALLS = 5
const MODEL_ERROR_RATE_THRESHOLD = 0.5

/**
 * Decide whether one `checkEndpoint` result counts as healthy, and why —
 * `reason` is only meaningful when `healthy` is `false`, and is what ends
 * up in the notification text.
 */
export function evaluate(result) {
  if (!result.ok) {
    return {
      healthy: false,
      reason: result.reachable
        ? `responded ${result.status}`
        : `unreachable (${result.error})`,
    }
  }
  const model = result.body?.model
  if (
    model &&
    typeof model.calls === 'number' &&
    typeof model.errorRate === 'number' &&
    model.calls >= MODEL_ERROR_MIN_CALLS &&
    model.errorRate >= MODEL_ERROR_RATE_THRESHOLD
  ) {
    return {
      healthy: false,
      reason: `model provider error rate ${Math.round(model.errorRate * 100)}% over ${model.calls} calls`,
    }
  }
  return { healthy: true, reason: undefined }
}

/**
 * Compare this poll's results against the last-known state and decide what
 * to notify about — a transition only, in either direction.
 *
 * `previousHealthy` has no entry for a name it has never observed; that is
 * treated as "assumed healthy" rather than "assumed unhealthy", so the
 * monitor's own startup is silent when everything is actually fine, but
 * still pages immediately if a process is *already* down the moment this
 * process starts watching — the box having just rebooted mid-outage must
 * not delay the page until the next real transition.
 *
 * A pure function, exported so the transition logic is tested without a
 * network call, a timer, or an actual notification.
 */
export function planNotifications(previousHealthy, results) {
  const notifications = []
  const nextHealthy = new Map(previousHealthy)
  for (const result of results) {
    const { healthy, reason } = evaluate(result)
    const was = previousHealthy.has(result.name)
      ? previousHealthy.get(result.name)
      : true
    if (was !== healthy) {
      notifications.push({ name: result.name, healthy, reason })
    }
    nextHealthy.set(result.name, healthy)
  }
  return { notifications, nextHealthy }
}

/** The text sent for one transition. */
export function formatNotification({ name, healthy, reason }) {
  return healthy
    ? `[ops-monitor] ${name} recovered`
    : `[ops-monitor] ${name} is unhealthy: ${reason}`
}

/**
 * Deliver one notification: POST to the configured webhook if there is
 * one, and always write it to stdout/stderr either way (error level for an
 * outage, so it stands out in `logs/ops-monitor.log`; info for a
 * recovery). Never throws — a failed delivery is itself logged rather than
 * crashing the monitor that exists to notice failures.
 */
export async function notify(
  text,
  healthy,
  { webhookUrl = process.env.OPS_ALERT_WEBHOOK_URL, fetchFn = fetch } = {}
) {
  const log = healthy ? console.log : console.error
  if (!webhookUrl) {
    log(`${text} (OPS_ALERT_WEBHOOK_URL is not set — logged only)`)
    return
  }
  try {
    await fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Both keys, so this one POST is understood by a Discord or a Slack
      // incoming webhook without branching on which was configured.
      body: JSON.stringify({ content: text, text }),
      signal: AbortSignal.timeout(5000),
    })
    log(text)
  } catch (error) {
    console.error(
      `${text} (webhook delivery failed: ${error instanceof Error ? error.message : String(error)})`
    )
  }
}

async function run() {
  const pollIntervalMs =
    Number(process.env.OPS_ALERT_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS
  const endpoints = healthEndpoints()
  const webhookConfigured = Boolean(process.env.OPS_ALERT_WEBHOOK_URL)

  console.log(
    `[ops-monitor] watching ${endpoints.map((e) => e.name).join(', ')} every ${pollIntervalMs}ms` +
      (webhookConfigured
        ? ''
        : ' (no OPS_ALERT_WEBHOOK_URL — notifications will only reach logs/ops-monitor.log)')
  )

  let previousHealthy = new Map()
  const tick = async () => {
    const results = await checkAll(endpoints)
    const { notifications, nextHealthy } = planNotifications(
      previousHealthy,
      results
    )
    previousHealthy = nextHealthy
    for (const notification of notifications) {
      await notify(formatNotification(notification), notification.healthy)
    }
  }

  await tick()
  const interval = setInterval(() => {
    tick().catch((error) => console.error('[ops-monitor] tick failed', error))
  }, pollIntervalMs)

  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    clearInterval(interval)
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

// Only run when invoked directly, so the exported functions above can be
// imported by a test — or by `scripts/deploy.sh`'s own reasoning — without
// starting the poll loop.
if (process.argv[1] && process.argv[1].endsWith('ops-monitor.mjs')) run()
