/**
 * Tests for the health-check helper `scripts/deploy.sh` and
 * `scripts/ops-monitor.mjs` both use (OPS-8, OPS-12).
 *
 * `checkEndpoint`/`checkAll` are exercised against a real, ephemeral
 * `node:http` server rather than a mocked `fetch` — the thing worth pinning
 * is the real distinction between "answered 200", "answered something else"
 * and "nothing there to answer at all", and a mock can assert whatever
 * shape it is told to return regardless of whether that shape is reachable
 * through a real socket.
 */

import { createServer } from 'node:http'
import test from 'node:test'
import assert from 'node:assert/strict'

import { envSchema } from '@bloombot/config'

import {
  checkAll,
  checkEndpoint,
  DEFAULT_HEALTH_PORTS,
  describeResult,
  healthEndpoints,
} from './health-check.mjs'

/** Starts a throwaway HTTP server on an ephemeral port that always answers the same way, and returns its base URL plus a `close()`. */
function startFixtureServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}

test('checkEndpoint reports ok on a 200 with its parsed body', async () => {
  const fixture = await startFixtureServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ready: true }))
  })
  try {
    const result = await checkEndpoint({
      name: 'x',
      url: fixture.url + '/health',
    })
    assert.equal(result.ok, true)
    assert.equal(result.reachable, true)
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, { ready: true })
  } finally {
    await fixture.close()
  }
})

test('checkEndpoint reports not-ok, but reachable, on a 503', async () => {
  const fixture = await startFixtureServer((_req, res) => {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ready: false }))
  })
  try {
    const result = await checkEndpoint({
      name: 'x',
      url: fixture.url + '/health',
    })
    assert.equal(result.ok, false)
    assert.equal(result.reachable, true)
    assert.equal(result.status, 503)
  } finally {
    await fixture.close()
  }
})

test('checkEndpoint reports unreachable, not a thrown error, when nothing is listening', async () => {
  // Port 1 is a real, reserved port nothing on the test host binds a user
  // service to — a connection to it fails fast rather than needing a real
  // "start a server, then close it" dance to manufacture the same failure.
  const result = await checkEndpoint(
    { name: 'x', url: 'http://127.0.0.1:1/health' },
    { timeoutMs: 500 }
  )
  assert.equal(result.ok, false)
  assert.equal(result.reachable, false)
  assert.equal(result.status, undefined)
  assert.ok(result.error)
})

test('checkAll runs every endpoint and preserves its name', async () => {
  const fixture = await startFixtureServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  try {
    const results = await checkAll([
      { name: 'a', url: fixture.url + '/health' },
      { name: 'b', url: 'http://127.0.0.1:1/health' },
    ])
    assert.deepEqual(
      results.map((r) => [r.name, r.ok]),
      [
        ['a', true],
        ['b', false],
      ]
    )
  } finally {
    await fixture.close()
  }
})

test('describeResult names the process and what happened', () => {
  assert.equal(
    describeResult({ name: 'api', ok: true, reachable: true, status: 200 }),
    'api: ok'
  )
  assert.equal(
    describeResult({ name: 'api', ok: false, reachable: true, status: 503 }),
    'api: responded 503'
  )
  assert.equal(
    describeResult({
      name: 'api',
      ok: false,
      reachable: false,
      error: 'ECONNREFUSED',
    }),
    'api: unreachable (ECONNREFUSED)'
  )
})

test('healthEndpoints defaults to the same ports packages/config/src/env.ts documents', () => {
  const endpoints = healthEndpoints({})
  assert.deepEqual(
    endpoints.map((e) => e.url),
    [
      'http://127.0.0.1:3000/health',
      'http://127.0.0.1:3001/health',
      'http://127.0.0.1:3002/health',
      'http://127.0.0.1:3003/health',
    ]
  )
  // The duplicated defaults this file's own module comment warns about —
  // pinned against the schema's real defaults so the two cannot silently
  // drift apart.
  for (const [name, { envVar, port }] of Object.entries(DEFAULT_HEALTH_PORTS)) {
    assert.equal(
      envSchema.shape[envVar].parse(undefined),
      port,
      `${name}'s default (${port}) no longer matches envSchema.${envVar}`
    )
  }
})

test('healthEndpoints reads an override from the environment', () => {
  const endpoints = healthEndpoints({ API_PORT: '4100' })
  const api = endpoints.find((e) => e.name === 'api')
  assert.equal(api.url, 'http://127.0.0.1:4100/health')
})
