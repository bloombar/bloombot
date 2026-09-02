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
 * unreachable"), so `evaluate` below reads the `model.calls`/`model.errors`
 * counters `apps/bot`'s health body already carries and treats a sustained
 * high error rate as unhealthy too, even while the gateway itself is fine
 * — windowed against the *previous* poll's own snapshot, not the lifetime
 * total those counters carry (`evaluate`'s own doc comment has the full
 * reasoning for why a lifetime average cannot actually notice a real
 * outage in any useful time).
 *
 * Notification is a plain HTTP POST to `OPS_ALERT_WEBHOOK_URL` — Discord's
 * and Slack's own incoming-webhook formats both accept a JSON body with a
 * `content`/`text` string and ignore keys they do not recognize, so one
 * POST works with either without a vendor SDK, and without standing up any
 * new service: an operator creates one incoming webhook (Discord: a text
 * channel's own Integrations settings; Slack: an app's Incoming Webhooks
 * feature) and sets the URL it hands back. When no webhook is configured,
 * the notification still happens: it is written to this process's own
 * stdout/stderr, which pm2 (OPS-2, `ecosystem.config.cjs`'s own `ops-monitor`
 * entry) already redirects to `logs/pm2-ops-monitor-out.log`/
 * `logs/pm2-ops-monitor-error.log` — degraded, not silent, the same "found
 * out from logs, not an invoice" shape `apps/api`'s own
 * `logging-email-sender.ts` uses for an equivalent gap (no real mail
 * transport configured yet).
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
import { loadDotEnvOnce } from './load-dotenv.mjs'

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
 *
 * `previousModel` is the `{calls, errors}` baseline this same process's own
 * `model` body is windowed against (`undefined` on the first observation)
 * — this function reads the delta since that baseline, not the lifetime
 * total, and returns the baseline the *next* tick should use.
 *
 * Rework finding — `createCountingModelClient` (`packages/core`) counts
 * since the process started and never resets, so `model.errorRate` in the
 * health body is a lifetime average, not the "running error rate"
 * `docs/CUTOVER.md`'s own §5 and `docs/DECISIONS.md`'s D-41 both describe.
 * Evaluated against the lifetime total, a course server that has been up a
 * week with 400 calls and 8 errors sits at 2% — if the provider then goes
 * fully down, reaching the 50%-of-5 threshold on the *lifetime* total needs
 * roughly 384 more consecutive failures, on a poll every 30s that is
 * something like 19 hours before this ever notices. The mirror case is as
 * bad the other way: the first 5 calls right after a deploy resets the
 * counters can trip the threshold on ordinary noise, and "recovered" would
 * not fire again for hours while the lifetime average slowly dilutes back
 * down. Windowing against a baseline instead makes this a real "since
 * roughly the last time this had enough calls to say anything" measurement.
 *
 * Second rework finding — the first version of this window advanced the
 * baseline to the current snapshot on *every* tick, evaluated or not. A
 * course server making four model calls per 30s poll — a busy classroom,
 * not a quiet one — never accumulates five calls *within one poll*, so
 * `windowCalls` was `4 < MODEL_ERROR_MIN_CALLS` on every single tick and the
 * un-evaluated remainder was discarded each time: a sustained, total outage
 * on that server was never noticed at all, a regression against even the
 * lifetime-average behaviour it replaced (which at least fired eventually).
 * The baseline now only advances once a window actually accumulates enough
 * calls to be evaluated — held unchanged, tick over tick, while it does
 * not — so a quiet server's window simply spans more polls rather than
 * silently losing what it already saw. Once a window is evaluated, the
 * baseline resets to that moment, so this still never grows back into a
 * lifetime average.
 */
export function evaluate(result, previousModel) {
  if (!result.ok) {
    return {
      healthy: false,
      reason: result.reachable
        ? `responded ${result.status}`
        : `unreachable (${result.error})`,
      model: previousModel,
    }
  }
  const model = result.body?.model
  if (
    !model ||
    typeof model.calls !== 'number' ||
    typeof model.errors !== 'number'
  ) {
    return { healthy: true, reason: undefined, model: previousModel }
  }
  if (!previousModel) {
    // First observation for this process — nothing to window against yet.
    // Seed the baseline here rather than at `{calls: 0, errors: 0}`, so the
    // very first real window starts from this moment, not from whatever
    // the lifetime total already was when the monitor itself started.
    return {
      healthy: true,
      reason: undefined,
      model: { calls: model.calls, errors: model.errors },
    }
  }

  let windowCalls
  let windowErrors
  if (model.calls >= previousModel.calls) {
    // The ordinary case: this process kept running since the baseline was
    // set, so the window is the delta since then.
    windowCalls = model.calls - previousModel.calls
    windowErrors = model.errors - previousModel.errors
  } else {
    // The counters went backwards — the process restarted since the
    // baseline was set, and `createCountingModelClient`'s own counters
    // reset with it (its own module comment: "since it was built"), not a
    // real negative call count. The window becomes the raw post-restart
    // totals instead of a nonsensical negative rate; holding the (now
    // stale) baseline below still accumulates correctly on later ticks,
    // the same as the "not enough calls yet" case.
    windowCalls = model.calls
    windowErrors = model.errors
  }

  if (windowCalls < MODEL_ERROR_MIN_CALLS) {
    // Not enough calls in the window yet to mean anything — hold the
    // baseline exactly as it was, so the next tick's window keeps
    // accumulating from the same starting point instead of discarding
    // what this tick already saw.
    //
    // Carry the last *evaluated* verdict forward rather than asserting
    // health. Returning `healthy: true` here was a real defect: after a
    // page, the baseline has just been reset, so the very next tick's
    // window holds almost nothing and this branch declared the provider
    // recovered — 30 seconds after saying it was down, while it was still
    // totally down. On a course making a couple of model calls per poll
    // that produced an endless page/recover flap, contradicting
    // `docs/CUTOVER.md` §5's promise that a sustained outage pages once.
    // "Too little evidence to decide" must mean "nothing changed", not
    // "everything is fine".
    return {
      healthy: previousModel.verdict?.healthy ?? true,
      reason: previousModel.verdict?.reason,
      model: previousModel,
    }
  }

  // Enough accumulated to decide. Reset the baseline to right now — the
  // next window starts fresh from this point, whether or not this one
  // paged, which is what keeps this a windowed measurement rather than a
  // lifetime average that merely resets less often.
  if (windowErrors / windowCalls >= MODEL_ERROR_RATE_THRESHOLD) {
    const reason = `model provider error rate ${Math.round((windowErrors / windowCalls) * 100)}% over the last ${windowCalls} calls`
    return {
      healthy: false,
      reason,
      // The verdict rides along with the baseline so the accumulating
      // branch above can hold it until the next window is decidable.
      model: {
        calls: model.calls,
        errors: model.errors,
        verdict: { healthy: false, reason },
      },
    }
  }
  return {
    healthy: true,
    reason: undefined,
    model: {
      calls: model.calls,
      errors: model.errors,
      verdict: { healthy: true, reason: undefined },
    },
  }
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
 * `previousModel` carries each process's own `{calls, errors}` snapshot
 * across ticks, the same way `previousHealthy` carries the healthy/
 * unhealthy verdict — see `evaluate`'s own doc comment for why this needs
 * to be a delta rather than a point-in-time read.
 *
 * A pure function, exported so the transition logic is tested without a
 * network call, a timer, or an actual notification.
 */
export function planNotifications(previousHealthy, previousModel, results) {
  const notifications = []
  const nextHealthy = new Map(previousHealthy)
  const nextModel = new Map(previousModel)
  for (const result of results) {
    const { healthy, reason, model } = evaluate(
      result,
      previousModel.get(result.name)
    )
    const was = previousHealthy.has(result.name)
      ? previousHealthy.get(result.name)
      : true
    if (was !== healthy) {
      notifications.push({ name: result.name, healthy, reason })
    }
    nextHealthy.set(result.name, healthy)
    if (model) nextModel.set(result.name, model)
  }
  return { notifications, nextHealthy, nextModel }
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
 * outage, so it stands out in pm2's own `logs/pm2-ops-monitor-error.log`;
 * info, to `logs/pm2-ops-monitor-out.log`, for a recovery). Never throws —
 * a failed delivery is itself logged rather than crashing the monitor that
 * exists to notice failures. A webhook that answers but rejects the
 * message (a wrong or deleted webhook — Discord's own `404 Unknown
 * Webhook`, say) is treated as a delivery failure too: an unchecked
 * `fetchFn` call would log the exact same "delivered" line whether or not
 * anything on the other end actually received it, which is worse than
 * useless the day the alerting channel itself was reconfigured.
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
    const response = await fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Both keys, so this one POST is understood by a Discord or a Slack
      // incoming webhook without branching on which was configured.
      body: JSON.stringify({ content: text, text }),
      signal: AbortSignal.timeout(5000),
    })
    // Rework finding — this used to log "delivered" the moment `fetchFn`
    // resolved at all, whether or not the response said the message was
    // actually accepted. A `fetch` only rejects on a network-level failure;
    // a webhook that answers with a `4xx`/`5xx` (a deleted incoming
    // webhook, Discord's own `404 Unknown Webhook`) resolves normally, so
    // the old code logged the exact same "delivered" line either way —
    // indistinguishable, from the log alone, from an alert that actually
    // reached anyone.
    if (!response.ok) {
      console.error(
        `${text} (webhook delivery failed: responded ${response.status})`
      )
      return
    }
    log(text)
  } catch (error) {
    console.error(
      `${text} (webhook delivery failed: ${error instanceof Error ? error.message : String(error)})`
    )
  }
}

/**
 * Loads `.env` (a value already in `process.env` wins) and resolves what
 * this run needs from it — the endpoints to poll, how often, and whether a
 * webhook is configured.
 *
 * Rework finding — this used to be inlined in `run()` below, reading
 * `process.env` directly with no `.env` load at all, so
 * `OPS_ALERT_WEBHOOK_URL` set only in `.env` (as `env.example` and every
 * one of this repository's own deployment docs tell an operator to do)
 * never reached the running process — pm2 does not load `.env` on a
 * process's behalf, and `ecosystem.config.cjs`'s own "every Node process
 * here loads `.env` itself" claim was false for this one process
 * specifically. Every notification silently degraded to a log line nobody
 * was watching.
 *
 * Pulled into its own function, taking an explicit `.env` path, for the
 * same testability reason `scripts/health-check.mjs`'s own
 * `resolveEndpoints` was — see that function's own doc comment.
 */
export function resolveMonitorConfig(path) {
  loadDotEnvOnce(path)
  return {
    pollIntervalMs:
      Number(process.env.OPS_ALERT_POLL_INTERVAL_MS) ||
      DEFAULT_POLL_INTERVAL_MS,
    endpoints: healthEndpoints(),
    webhookConfigured: Boolean(process.env.OPS_ALERT_WEBHOOK_URL),
  }
}

async function run() {
  const { pollIntervalMs, endpoints, webhookConfigured } =
    resolveMonitorConfig()

  console.log(
    `[ops-monitor] watching ${endpoints.map((e) => e.name).join(', ')} every ${pollIntervalMs}ms` +
      (webhookConfigured
        ? ''
        : ' (no OPS_ALERT_WEBHOOK_URL — notifications will only reach logs/pm2-ops-monitor-*.log)')
  )

  let previousHealthy = new Map()
  let previousModel = new Map()
  const tick = async () => {
    const results = await checkAll(endpoints)
    const { notifications, nextHealthy, nextModel } = planNotifications(
      previousHealthy,
      previousModel,
      results
    )
    previousHealthy = nextHealthy
    previousModel = nextModel
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
