/**
 * Tests for OPS-12's transition logic and notification delivery.
 *
 * `evaluate`/`planNotifications`/`formatNotification` are pure — no timer, no
 * network — so they are tested directly. `notify` is exercised against an
 * injected `fetchFn`, the same seam `scripts/health-check.mjs`'s own
 * `checkEndpoint` takes, rather than a real webhook.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  evaluate,
  formatNotification,
  notify,
  planNotifications,
  resolveMonitorConfig,
} from './ops-monitor.mjs'

test('evaluate: a plain ok result is healthy', () => {
  const result = evaluate({ ok: true, reachable: true, status: 200 })
  assert.equal(result.healthy, true)
  assert.equal(result.reason, undefined)
})

test('evaluate: an unreachable process is unhealthy, naming why', () => {
  const result = evaluate({
    ok: false,
    reachable: false,
    error: 'ECONNREFUSED',
  })
  assert.equal(result.healthy, false)
  assert.match(result.reason, /unreachable/)
})

test('evaluate: a 503 is unhealthy, naming the status', () => {
  const result = evaluate({ ok: false, reachable: true, status: 503 })
  assert.equal(result.healthy, false)
  assert.match(result.reason, /503/)
})

// Rework finding — `createCountingModelClient`'s own counters never reset;
// `evaluate` has to window against the *previous* poll's own snapshot
// rather than read the lifetime total, or a real, sustained outage takes
// hours (or never) to notice, and a deploy that just reset the counters can
// false-positive on ordinary noise. These cases exercise that windowing
// directly, the same failure this rework round's own finding describes.

test('evaluate: a high error rate within one window (no previous snapshot) does not page — nothing to window against yet', () => {
  const result = evaluate({
    ok: true,
    reachable: true,
    status: 200,
    body: {
      gatewayConnected: true,
      model: { calls: 10, errors: 8, errorRate: 0.8 },
    },
  })
  assert.equal(result.healthy, true)
  assert.deepEqual(result.model, { calls: 10, errors: 8 })
})

test('evaluate: a high error rate in the delta since the previous snapshot pages, even though the lifetime rate is low', () => {
  // Lifetime: 108 calls, 8 errors (7.4%) — would never trip a lifetime
  // threshold. This tick's own window: 8 calls, 6 errors (75%) — a real,
  // current outage.
  const result = evaluate(
    {
      ok: true,
      reachable: true,
      status: 200,
      body: {
        gatewayConnected: true,
        model: { calls: 108, errors: 8, errorRate: 8 / 108 },
      },
    },
    { calls: 100, errors: 2 }
  )
  assert.equal(result.healthy, false)
  assert.match(result.reason, /75%/)
  assert.match(result.reason, /last 8 calls/)
  assert.deepEqual(result.model, { calls: 108, errors: 8 })
})

test('evaluate: a lifetime error rate over 50% does not page when the delta since the last poll is clean — the old lifetime-average bug, inverted', () => {
  // Lifetime: 108 calls, 60 errors (55%). This tick's own window: 8 calls,
  // 0 errors — the outage already ended; a lifetime-average check would
  // still be paging on stale history.
  const result = evaluate(
    {
      ok: true,
      reachable: true,
      status: 200,
      body: {
        gatewayConnected: true,
        model: { calls: 108, errors: 60, errorRate: 60 / 108 },
      },
    },
    { calls: 100, errors: 60 }
  )
  assert.equal(result.healthy, true)
})

test('evaluate: too few calls in the window to mean anything stays healthy, even at 100% error', () => {
  const result = evaluate(
    {
      ok: true,
      reachable: true,
      status: 200,
      body: {
        gatewayConnected: true,
        model: { calls: 101, errors: 1, errorRate: 1 / 101 },
      },
    },
    { calls: 100, errors: 0 }
  )
  assert.equal(result.healthy, true)
})

test('evaluate: a process restart (counters reset lower than the previous snapshot) evaluates the post-restart totals, not a negative rate', () => {
  const result = evaluate(
    {
      ok: true,
      reachable: true,
      status: 200,
      body: {
        gatewayConnected: true,
        model: { calls: 6, errors: 5, errorRate: 5 / 6 },
      },
    },
    { calls: 500, errors: 20 }
  )
  assert.equal(result.healthy, false)
  assert.deepEqual(result.model, { calls: 6, errors: 5 })
})

test('evaluate: an unreachable result carries the previous model snapshot forward unchanged', () => {
  const result = evaluate(
    { ok: false, reachable: false, error: 'ECONNREFUSED' },
    { calls: 100, errors: 2 }
  )
  assert.deepEqual(result.model, { calls: 100, errors: 2 })
})

test('planNotifications: a first, healthy observation notifies nobody', () => {
  const { notifications, nextHealthy } = planNotifications(
    new Map(),
    new Map(),
    [{ name: 'api', ok: true, reachable: true, status: 200 }]
  )
  assert.deepEqual(notifications, [])
  assert.equal(nextHealthy.get('api'), true)
})

test('planNotifications: a first observation that is already unhealthy still pages — a reboot mid-outage must not wait for a transition that already happened', () => {
  const { notifications } = planNotifications(new Map(), new Map(), [
    { name: 'api', ok: false, reachable: false, error: 'ECONNREFUSED' },
  ])
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].name, 'api')
  assert.equal(notifications[0].healthy, false)
})

test('planNotifications: healthy -> unhealthy notifies once', () => {
  const previous = new Map([['api', true]])
  const { notifications } = planNotifications(previous, new Map(), [
    { name: 'api', ok: false, reachable: true, status: 503 },
  ])
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].healthy, false)
})

test('planNotifications: staying unhealthy across polls notifies nothing further — one page per outage, not one per poll', () => {
  const previous = new Map([['api', false]])
  const { notifications } = planNotifications(previous, new Map(), [
    { name: 'api', ok: false, reachable: true, status: 503 },
  ])
  assert.deepEqual(notifications, [])
})

test('planNotifications: unhealthy -> healthy notifies a recovery', () => {
  const previous = new Map([['api', false]])
  const { notifications } = planNotifications(previous, new Map(), [
    { name: 'api', ok: true, reachable: true, status: 200 },
  ])
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].healthy, true)
})

test('planNotifications: independent processes are tracked independently', () => {
  const previous = new Map([
    ['api', true],
    ['bot', false],
  ])
  const { notifications } = planNotifications(previous, new Map(), [
    { name: 'api', ok: true, reachable: true, status: 200 },
    { name: 'bot', ok: true, reachable: true, status: 200 },
  ])
  assert.deepEqual(
    notifications.map((n) => n.name),
    ['bot']
  )
})

test("planNotifications: carries each process's own model snapshot forward independently, across ticks", () => {
  const previousModel = new Map([['bot', { calls: 100, errors: 2 }]])
  const { nextModel } = planNotifications(new Map(), previousModel, [
    {
      name: 'bot',
      ok: true,
      reachable: true,
      status: 200,
      body: {
        gatewayConnected: true,
        model: { calls: 110, errors: 3, errorRate: 3 / 110 },
      },
    },
    { name: 'api', ok: true, reachable: true, status: 200 },
  ])
  assert.deepEqual(nextModel.get('bot'), { calls: 110, errors: 3 })
  assert.equal(nextModel.has('api'), false)
})

test('planNotifications: a sustained provider outage, windowed tick by tick, pages once and recovers once', () => {
  // Simulates three polls 30s apart: healthy, then a real outage in the
  // second window, then recovered in the third.
  let previousHealthy = new Map()
  let previousModel = new Map()
  const allNotifications = []

  const tick = (calls, errors) => {
    const { notifications, nextHealthy, nextModel } = planNotifications(
      previousHealthy,
      previousModel,
      [
        {
          name: 'bot',
          ok: true,
          reachable: true,
          status: 200,
          body: {
            gatewayConnected: true,
            model: { calls, errors, errorRate: errors / calls },
          },
        },
      ]
    )
    previousHealthy = nextHealthy
    previousModel = nextModel
    allNotifications.push(...notifications)
  }

  tick(10, 0) // baseline
  tick(20, 9) // window: 10 calls, 9 errors — a real outage
  tick(30, 9) // window: 10 calls, 0 errors — recovered

  assert.deepEqual(
    allNotifications.map((n) => n.healthy),
    [false, true]
  )
})

// Rework finding — the first windowing fix advanced the baseline to the
// current snapshot on *every* tick, evaluated or not, so a process making
// fewer than MODEL_ERROR_MIN_CALLS calls per poll never accumulated enough
// in a single window to ever be evaluated: `windowCalls` was always below
// the threshold, and the un-evaluated remainder was silently discarded each
// tick. A quiet course server (as few as one or two model calls per poll)
// having a *total* outage was never noticed at all. This reproduces that
// exact shape and proves the fix accumulates across ticks instead.
test('planNotifications: a low-traffic total outage still pages eventually — the window accumulates across ticks rather than resetting every poll', () => {
  let previousHealthy = new Map()
  let previousModel = new Map()
  const allNotifications = []

  const tick = (calls, errors) => {
    const { notifications, nextHealthy, nextModel } = planNotifications(
      previousHealthy,
      previousModel,
      [
        {
          name: 'bot',
          ok: true,
          reachable: true,
          status: 200,
          body: {
            gatewayConnected: true,
            model: { calls, errors, errorRate: errors / calls },
          },
        },
      ]
    )
    previousHealthy = nextHealthy
    previousModel = nextModel
    allNotifications.push(...notifications)
  }

  // Two calls per poll, every one of them an error from the moment the
  // outage starts (poll 2 onward) — never five calls within any single
  // 30s poll, so the bug this test guards against would never fire at all.
  tick(2, 0) // poll 1: baseline seeded, 2 calls, healthy
  tick(4, 2) // poll 2: 2 new calls, both errors — window so far: 2 calls (< 5), held
  tick(6, 4) // poll 3: 2 more — window: 4 calls since poll 1's baseline (< 5), held
  tick(8, 6) // poll 4: 2 more — window: 6 calls since poll 1's baseline (>= 5), all errors

  assert.deepEqual(
    allNotifications.map((n) => n.healthy),
    [false]
  )
})

// The mirror of the case above, confirming a genuinely quiet, healthy
// server does not page just because it takes several polls to accumulate
// enough calls to be evaluated at all.
test('planNotifications: a low-traffic, healthy server never pages while it accumulates', () => {
  let previousHealthy = new Map()
  let previousModel = new Map()
  const allNotifications = []

  const tick = (calls, errors) => {
    const { notifications, nextHealthy, nextModel } = planNotifications(
      previousHealthy,
      previousModel,
      [
        {
          name: 'bot',
          ok: true,
          reachable: true,
          status: 200,
          body: {
            gatewayConnected: true,
            model: { calls, errors, errorRate: errors / calls },
          },
        },
      ]
    )
    previousHealthy = nextHealthy
    previousModel = nextModel
    allNotifications.push(...notifications)
  }

  tick(1, 0)
  tick(2, 0)
  tick(3, 0)
  tick(4, 0)
  tick(5, 0)
  tick(6, 0)

  assert.deepEqual(allNotifications, [])
})

test('formatNotification: an outage names the reason', () => {
  assert.equal(
    formatNotification({
      name: 'worker',
      healthy: false,
      reason: 'responded 503',
    }),
    '[ops-monitor] worker is unhealthy: responded 503'
  )
})

test('formatNotification: a recovery names no reason', () => {
  assert.equal(
    formatNotification({ name: 'worker', healthy: true }),
    '[ops-monitor] worker recovered'
  )
})

test('notify: posts to the webhook when one is configured, in a shape both Discord and Slack accept', async () => {
  const calls = []
  const fetchFn = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 204 }
  }
  await notify('[ops-monitor] api is unhealthy: responded 503', false, {
    webhookUrl: 'https://example.test/webhook',
    fetchFn,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://example.test/webhook')
  assert.equal(calls[0].init.method, 'POST')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.content, '[ops-monitor] api is unhealthy: responded 503')
  assert.equal(body.text, '[ops-monitor] api is unhealthy: responded 503')
})

test('notify: never throws when no webhook is configured', async () => {
  await assert.doesNotReject(() =>
    notify('[ops-monitor] api recovered', true, { webhookUrl: undefined })
  )
})

test('notify: never throws when webhook delivery itself fails', async () => {
  const fetchFn = async () => {
    throw new Error('network down')
  }
  await assert.doesNotReject(() =>
    notify('[ops-monitor] api is unhealthy: responded 503', false, {
      webhookUrl: 'https://example.test/webhook',
      fetchFn,
    })
  )
})

// Rework finding — a webhook that answers but rejects the message (a wrong
// or deleted incoming webhook — Discord's own `404 Unknown Webhook`, a
// Slack webhook someone revoked) used to log identically to a delivered
// page, because only a thrown error was treated as a failure.
test('notify: a non-ok webhook response is treated as a failed delivery, not a success', async () => {
  const logged = []
  const originalError = console.error
  const originalLog = console.log
  console.error = (...args) => logged.push(['error', args.join(' ')])
  console.log = (...args) => logged.push(['log', args.join(' ')])
  try {
    await notify('[ops-monitor] api is unhealthy: responded 503', false, {
      webhookUrl: 'https://example.test/webhook',
      fetchFn: async () => ({ ok: false, status: 404 }),
    })
  } finally {
    console.error = originalError
    console.log = originalLog
  }

  assert.equal(logged.length, 1)
  assert.equal(logged[0][0], 'error')
  assert.match(logged[0][1], /webhook delivery failed/)
  assert.match(logged[0][1], /404/)
})

// Rework finding — `run()` used to read `process.env.OPS_ALERT_WEBHOOK_URL`
// with no `.env` load at all, and pm2 does not load `.env` on a process's
// behalf (`ecosystem.config.cjs` gives `ops-monitor` no `env:`/`env_file:`
// block) — so a webhook set only in `.env`, exactly as `env.example` and
// this repository's own deployment docs tell an operator to configure it,
// silently never reached the running process; every page degraded to a log
// line nobody was watching. This proves the load actually happens, without
// ever writing a file named `.env` (a hook in this repository blocks that).
test('resolveMonitorConfig loads OPS_ALERT_WEBHOOK_URL from a .env-shaped file, not only from process.env', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-monitor-test-'))
  const path = join(dir, 'environment-fixture')
  writeFileSync(
    path,
    'OPS_ALERT_WEBHOOK_URL=https://example.test/from-file\nOPS_ALERT_POLL_INTERVAL_MS=5000\n',
    'utf8'
  )
  delete process.env.OPS_ALERT_WEBHOOK_URL
  delete process.env.OPS_ALERT_POLL_INTERVAL_MS
  try {
    const config = resolveMonitorConfig(path)
    assert.equal(config.webhookConfigured, true)
    assert.equal(
      process.env.OPS_ALERT_WEBHOOK_URL,
      'https://example.test/from-file'
    )
    assert.equal(config.pollIntervalMs, 5000)
  } finally {
    delete process.env.OPS_ALERT_WEBHOOK_URL
    delete process.env.OPS_ALERT_POLL_INTERVAL_MS
    rmSync(dir, { recursive: true, force: true })
  }
})
