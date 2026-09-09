/**
 * Tests for `scripts/check-discord-oauth.mjs` (TEN-4) — the classifier is
 * the part worth pinning hardest, so it gets the bulk of the coverage; the
 * network call is stubbed rather than made for real, the same "never call
 * the real thing in a test" shape `scripts/health-check.test.mjs` uses for
 * its own fixture server.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { stripTrailingSlashes as configStripTrailingSlashes } from '@bloombot/config'

import {
  classifyRedirectMismatch,
  deriveRedirectUri,
  fetchApplication,
  readRequiredEnv,
  stripTrailingSlashes,
} from './check-discord-oauth.mjs'

// --- readRequiredEnv -------------------------------------------------------

test('readRequiredEnv reports every missing variable by name, not just the first', () => {
  const result = readRequiredEnv({ BOT_TOKEN: 'x' }, [
    'BOT_APP_ID',
    'BOT_TOKEN',
    'PUBLIC_APP_URL',
  ])
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['BOT_APP_ID', 'PUBLIC_APP_URL'])
})

test('readRequiredEnv succeeds when every variable is present', () => {
  const result = readRequiredEnv(
    {
      BOT_APP_ID: '1',
      BOT_TOKEN: 'x',
      PUBLIC_APP_URL: 'https://example.test',
    },
    ['BOT_APP_ID', 'BOT_TOKEN', 'PUBLIC_APP_URL']
  )
  assert.equal(result.ok, true)
  assert.deepEqual(result.values, {
    BOT_APP_ID: '1',
    BOT_TOKEN: 'x',
    PUBLIC_APP_URL: 'https://example.test',
  })
})

// --- stripTrailingSlashes / deriveRedirectUri -------------------------------

test("stripTrailingSlashes matches packages/config's own normalisation", () => {
  // Duplicated locally rather than imported (this script must run without a
  // build) — pinned against the real transform so the two cannot silently
  // drift apart, the same "matches packages/config's own defaults" shape
  // `health-check.test.mjs` already uses for its own duplicated constants.
  for (const input of [
    'https://host',
    'https://host/',
    'https://host///',
    'http://localhost:5173/',
  ]) {
    assert.equal(
      stripTrailingSlashes(input),
      configStripTrailingSlashes(input),
      `stripTrailingSlashes(${input}) diverged from @bloombot/config`
    )
  }
})

test('deriveRedirectUri appends /discord/callback to a normalised PUBLIC_APP_URL', () => {
  assert.equal(
    deriveRedirectUri('https://bloombot.wonkledge.com'),
    'https://bloombot.wonkledge.com/discord/callback'
  )
})

test('deriveRedirectUri strips a trailing slash before appending, matching apps/api', () => {
  assert.equal(
    deriveRedirectUri('https://bloombot.wonkledge.com/'),
    'https://bloombot.wonkledge.com/discord/callback'
  )
})

// --- classifyRedirectMismatch -----------------------------------------------

const EXPECTED = 'https://bloombot.wonkledge.com/discord/callback'

test('classifyRedirectMismatch: exact match', () => {
  const result = classifyRedirectMismatch(EXPECTED, [EXPECTED])
  assert.equal(result.kind, 'match')
})

test('classifyRedirectMismatch: trailing slash on the registered side only', () => {
  const result = classifyRedirectMismatch(EXPECTED, [EXPECTED + '/'])
  assert.equal(result.kind, 'near-miss')
  assert.equal(result.difference, 'trailing-slash')
  assert.equal(result.registered, EXPECTED + '/')
})

test('classifyRedirectMismatch: trailing slash on the expected side only', () => {
  const registered = 'https://bloombot.wonkledge.com/discord/callback'
  const result = classifyRedirectMismatch(EXPECTED + '/', [registered])
  assert.equal(result.kind, 'near-miss')
  assert.equal(result.difference, 'trailing-slash')
})

test('classifyRedirectMismatch: http vs https', () => {
  const result = classifyRedirectMismatch(EXPECTED, [
    'http://bloombot.wonkledge.com/discord/callback',
  ])
  assert.equal(result.kind, 'near-miss')
  assert.equal(result.difference, 'scheme')
})

test('classifyRedirectMismatch: www. host vs apex', () => {
  const result = classifyRedirectMismatch(EXPECTED, [
    'https://www.bloombot.wonkledge.com/discord/callback',
  ])
  assert.equal(result.kind, 'near-miss')
  assert.equal(result.difference, 'www')
})

test('classifyRedirectMismatch: host case difference is a match with a warning, not a hard mismatch', () => {
  // Hosts are case-insensitive per RFC 3986 — Discord (and every browser)
  // treats these as the same host, so this must not report a mismatch.
  const result = classifyRedirectMismatch(EXPECTED, [
    'https://Bloombot.Wonkledge.com/discord/callback',
  ])
  assert.equal(result.kind, 'match')
  assert.ok(
    result.warning,
    'expected a warning explaining the host case difference'
  )
})

test('classifyRedirectMismatch: path case difference is a real mismatch', () => {
  // Paths ARE case-sensitive — unlike hosts, this must NOT be waved through.
  const result = classifyRedirectMismatch(EXPECTED, [
    'https://bloombot.wonkledge.com/Discord/callback',
  ])
  assert.equal(result.kind, 'near-miss')
  assert.equal(result.difference, 'path-case')
})

test('classifyRedirectMismatch: a percent-encoded vs decoded form of the same URI compares equal', () => {
  // Discord decodes percent-encoding before matching (the research this
  // slice does not redo), so a registered entry that spells the same path
  // with `%2F` must NOT be reported as a mismatch of any kind.
  const result = classifyRedirectMismatch(EXPECTED, [
    'https://bloombot.wonkledge.com/discord%2Fcallback',
  ])
  assert.equal(result.kind, 'match')
})

test('classifyRedirectMismatch: a completely unrelated URI is absent, not a near miss', () => {
  const result = classifyRedirectMismatch(EXPECTED, [
    'https://totally-different.example/oauth',
  ])
  assert.equal(result.kind, 'absent')
  assert.deepEqual(result.registered, [
    'https://totally-different.example/oauth',
  ])
})

test('classifyRedirectMismatch: an empty registered list', () => {
  const result = classifyRedirectMismatch(EXPECTED, [])
  assert.equal(result.kind, 'empty')
})

test('classifyRedirectMismatch: a near miss is named even among several registered entries', () => {
  const result = classifyRedirectMismatch(EXPECTED, [
    'https://unrelated.example/callback',
    EXPECTED + '/',
  ])
  assert.equal(result.kind, 'near-miss')
  assert.equal(result.registered, EXPECTED + '/')
})

// --- fetchApplication --------------------------------------------------------

test('fetchApplication returns the application on a 200', async () => {
  const fetchFn = async (url, init) => {
    assert.equal(url, 'https://discord.com/api/v10/applications/@me')
    assert.equal(init.headers.Authorization, 'Bot faketoken')
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: '123',
        name: 'Bloombot',
        redirect_uris: ['https://example.test/discord/callback'],
      }),
    }
  }
  const result = await fetchApplication('faketoken', { fetchFn })
  assert.equal(result.ok, true)
  assert.equal(result.application.id, '123')
  assert.equal(result.application.name, 'Bloombot')
})

test('fetchApplication reports a failed call without throwing, and never echoes the token', async () => {
  const fetchFn = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ message: '401: Unauthorized', code: 0 }),
  })
  const result = await fetchApplication('secret-token-value', { fetchFn })
  assert.equal(result.ok, false)
  assert.equal(result.status, 401)
  assert.ok(!JSON.stringify(result).includes('secret-token-value'))
})

test('fetchApplication reports a network failure without throwing', async () => {
  const fetchFn = async () => {
    throw new Error('getaddrinfo ENOTFOUND discord.com')
  }
  const result = await fetchApplication('faketoken', { fetchFn })
  assert.equal(result.ok, false)
  assert.ok(result.error)
})
