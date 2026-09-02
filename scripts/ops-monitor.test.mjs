/**
 * Tests for OPS-12's transition logic and notification delivery.
 *
 * `evaluate`/`planNotifications`/`formatNotification` are pure — no timer, no
 * network — so they are tested directly. `notify` is exercised against an
 * injected `fetchFn`, the same seam `scripts/health-check.mjs`'s own
 * `checkEndpoint` takes, rather than a real webhook.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  evaluate,
  formatNotification,
  notify,
  planNotifications,
} from './ops-monitor.mjs'

test('evaluate: a plain ok result is healthy', () => {
  assert.deepEqual(evaluate({ ok: true, reachable: true, status: 200 }), {
    healthy: true,
    reason: undefined,
  })
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

test('evaluate: a 200 with a high, sustained model error rate is unhealthy — the gateway alone does not cover a provider outage', () => {
  const result = evaluate({
    ok: true,
    reachable: true,
    status: 200,
    body: {
      gatewayConnected: true,
      model: { calls: 10, errors: 8, errorRate: 0.8 },
    },
  })
  assert.equal(result.healthy, false)
  assert.match(result.reason, /error rate/)
})

test('evaluate: a 200 with too few calls to mean anything stays healthy, even at 100% error', () => {
  const result = evaluate({
    ok: true,
    reachable: true,
    status: 200,
    body: {
      gatewayConnected: true,
      model: { calls: 1, errors: 1, errorRate: 1 },
    },
  })
  assert.equal(result.healthy, true)
})

test('evaluate: a 200 with a low error rate stays healthy', () => {
  const result = evaluate({
    ok: true,
    reachable: true,
    status: 200,
    body: {
      gatewayConnected: true,
      model: { calls: 50, errors: 2, errorRate: 0.04 },
    },
  })
  assert.equal(result.healthy, true)
})

test('planNotifications: a first, healthy observation notifies nobody', () => {
  const { notifications, nextHealthy } = planNotifications(new Map(), [
    { name: 'api', ok: true, reachable: true, status: 200 },
  ])
  assert.deepEqual(notifications, [])
  assert.equal(nextHealthy.get('api'), true)
})

test('planNotifications: a first observation that is already unhealthy still pages — a reboot mid-outage must not wait for a transition that already happened', () => {
  const { notifications } = planNotifications(new Map(), [
    { name: 'api', ok: false, reachable: false, error: 'ECONNREFUSED' },
  ])
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].name, 'api')
  assert.equal(notifications[0].healthy, false)
})

test('planNotifications: healthy -> unhealthy notifies once', () => {
  const previous = new Map([['api', true]])
  const { notifications } = planNotifications(previous, [
    { name: 'api', ok: false, reachable: true, status: 503 },
  ])
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].healthy, false)
})

test('planNotifications: staying unhealthy across polls notifies nothing further — one page per outage, not one per poll', () => {
  const previous = new Map([['api', false]])
  const { notifications } = planNotifications(previous, [
    { name: 'api', ok: false, reachable: true, status: 503 },
  ])
  assert.deepEqual(notifications, [])
})

test('planNotifications: unhealthy -> healthy notifies a recovery', () => {
  const previous = new Map([['api', false]])
  const { notifications } = planNotifications(previous, [
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
  const { notifications } = planNotifications(previous, [
    { name: 'api', ok: true, reachable: true, status: 200 },
    { name: 'bot', ok: true, reachable: true, status: 200 },
  ])
  assert.deepEqual(
    notifications.map((n) => n.name),
    ['bot']
  )
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
    return { ok: true }
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
