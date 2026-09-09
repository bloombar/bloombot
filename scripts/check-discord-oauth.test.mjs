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
  determineOutcome,
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
  // Strengthened per rework round 1: asserting only `result.warning` is
  // truthy could not have caught the warning text being wrong (it was
  // reused, verbatim, for the `:443`/userinfo false-match bug this round
  // fixes) — assert the warning actually names a case difference.
  assert.match(result.warning, /case/i)
})

// Rework round 1 — the reviewer reproduced a false MATCH: the WHATWG `URL`
// parser drops a default port and strips userinfo when it normalises
// `.host`, so the old `rawHostsDiffer` check (any difference between the
// *raw* host substrings, which include userinfo and the port) treated an
// explicit `:443`/userinfo difference as nothing more than a case
// difference and reported a false `match`. These three cases pin the fix:
// a real case difference still matches, but a port or userinfo difference
// — even though `url.host` itself agrees after normalisation — is now its
// own named near miss, never a silent match.

test('classifyRedirectMismatch: an explicit default port (https:443) is a near miss, not a match', () => {
  const result = classifyRedirectMismatch(EXPECTED, [
    'https://bloombot.wonkledge.com:443/discord/callback',
  ])
  assert.equal(result.kind, 'near-miss')
  assert.equal(result.difference, 'port')
})

test('classifyRedirectMismatch: an explicit default port (http:80) is a near miss, not a match', () => {
  const result = classifyRedirectMismatch(
    'http://host.example/discord/callback',
    ['http://host.example:80/discord/callback']
  )
  assert.equal(result.kind, 'near-miss')
  assert.equal(result.difference, 'port')
})

test('classifyRedirectMismatch: userinfo on the registered side only is a near miss, not a match', () => {
  const result = classifyRedirectMismatch(EXPECTED, [
    'https://user:pw@bloombot.wonkledge.com/discord/callback',
  ])
  assert.equal(result.kind, 'near-miss')
  assert.equal(result.difference, 'userinfo')
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

// Cheap-fix 1 (rework round 1) — `classifyRedirectMismatch` is an exported
// pure function and should be total over its documented input; `main()`
// never passes a non-array (it only calls this after checking
// `redirect_uris` is present), but a caller that does should get the same
// non-failing shape an empty list gives, not a thrown TypeError.
test('classifyRedirectMismatch: a non-array registered value degrades to the empty-list shape, not a throw', () => {
  assert.equal(classifyRedirectMismatch(EXPECTED, null).kind, 'empty')
  assert.equal(classifyRedirectMismatch(EXPECTED, undefined).kind, 'empty')
  assert.equal(classifyRedirectMismatch(EXPECTED, 'not-an-array').kind, 'empty')
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

// Cheap-fix 2 (rework round 1) — a 200 whose body cannot be parsed as JSON
// used to come back `{ ok: true, application: undefined }`, and `main()`
// then read `application.id` off it: an unhandled rejection and a stack
// trace, exactly the kind of failure this script exists to avoid.
test('fetchApplication reports a 200 with an unparseable body as a failure, not a silent undefined application', async () => {
  const fetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError('Unexpected token in JSON')
    },
  })
  const result = await fetchApplication('faketoken', { fetchFn })
  assert.equal(result.ok, false)
  assert.ok(result.error)
})

// --- determineOutcome (main()'s exit-code contract) -------------------------

// Cheap-fix 3 (rework round 1) — nothing pinned `main()`'s exit code before
// this round, including the "could not verify" outcome the brief singles
// out as its own, distinct, non-failing case (exit 0, neither "verified"
// nor "mismatch"). A regression flipping any of these would have passed the
// suite. `determineOutcome` is the pure outcome/exit-code mapping `main()`
// itself now just prints and exits with.
const BASE_ENV = {
  BOT_APP_ID: '123',
  BOT_TOKEN: 'faketoken',
  PUBLIC_APP_URL: 'https://bloombot.wonkledge.com',
}

function fetchFnReturning(application) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => application,
  })
}

test('determineOutcome: a verified match exits 0', async () => {
  const outcome = await determineOutcome(BASE_ENV, {
    fetchFn: fetchFnReturning({
      id: '123',
      name: 'Bloombot',
      redirect_uris: ['https://bloombot.wonkledge.com/discord/callback'],
    }),
  })
  assert.equal(outcome.exitCode, 0)
})

test('determineOutcome: a mismatch exits 1', async () => {
  const outcome = await determineOutcome(BASE_ENV, {
    fetchFn: fetchFnReturning({
      id: '123',
      name: 'Bloombot',
      redirect_uris: ['https://totally-different.example/oauth'],
    }),
  })
  assert.equal(outcome.exitCode, 1)
})

test('determineOutcome: could-not-verify (no redirect_uris in the response) exits 0, not 1', () => {
  return (async () => {
    const outcome = await determineOutcome(BASE_ENV, {
      fetchFn: fetchFnReturning({ id: '123', name: 'Bloombot' }),
    })
    assert.equal(outcome.exitCode, 0)
  })()
})

test('determineOutcome: missing environment variables exits 1', async () => {
  const outcome = await determineOutcome({})
  assert.equal(outcome.exitCode, 1)
})

test('determineOutcome: a failed Discord call exits 1', async () => {
  const outcome = await determineOutcome(BASE_ENV, {
    fetchFn: async () => ({
      ok: false,
      status: 401,
      json: async () => ({ message: '401: Unauthorized' }),
    }),
  })
  assert.equal(outcome.exitCode, 1)
})
