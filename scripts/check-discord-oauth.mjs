/**
 * Diagnoses `Invalid OAuth2 redirect_uri` on Discord's own consent screen
 * (TEN-4) in one command, runnable on the droplet or locally as
 * `npm run check:discord`.
 *
 * The research this slice does not redo already ruled out every code-side
 * cause: the `bot` scope imposes no special redirect rule, a malformed
 * PKCE challenge fails with `invalid_request` (not this error), the
 * permissions integer is valid, `applications.commands`/`integration_type=0`
 * are expected additions Discord's own client appends, and a scope problem
 * surfaces as `invalid_scope`. What remains is entirely Developer-Portal
 * state — the redirect URI this deployment sends is not registered on the
 * application it sends it to, either absent, near-missing (a stray slash,
 * `http` vs `https`, `www.` vs apex, path casing), unsaved behind the
 * portal's "Save Changes" banner, or registered on a *different*
 * application than `BOT_APP_ID` names in production. This script cannot fix
 * any of that — it collapses the diagnosis from "stare at two strings in a
 * browser" to one command that says which case it is.
 *
 * Deliberately a script, not a startup check in `apps/api`: a failing
 * startup probe would make the whole API refuse to boot over a
 * misconfiguration that only affects the Discord install flow, and it would
 * cost a network round-trip to Discord on every restart for a value that
 * only changes when an operator edits the portal. See `docs/DECISIONS.md`
 * for the full reasoning.
 *
 * Deliberately dependency-free from the workspace's own TypeScript packages
 * — the same reason `scripts/health-check.mjs`'s own module comment gives
 * for avoiding `@bloombot/config`: this must run on a droplet without a
 * build. `stripTrailingSlashes` below is duplicated from
 * `packages/config/src/env.ts` on purpose, not imported; a mismatch between
 * the two is what this file's own test's "matches packages/config's own
 * normalisation" case exists to catch.
 */

import { loadDotEnvOnce } from './load-dotenv.mjs'

/** The three environment variables this check needs, and nothing else. */
const REQUIRED_ENV_VARS = ['BOT_APP_ID', 'BOT_TOKEN', 'PUBLIC_APP_URL']

/**
 * Read a set of required variables out of an environment object (defaults
 * to `process.env`, injectable for tests), reporting every missing one by
 * name at once rather than failing on the first — the same
 * "every problem listed at once" reasoning `packages/config/src/env.ts`'s
 * own module comment gives for validating a whole environment together.
 */
export function readRequiredEnv(env, names = REQUIRED_ENV_VARS) {
  const missing = names.filter((name) => !env[name])
  if (missing.length > 0) {
    return { ok: false, missing }
  }
  const values = Object.fromEntries(names.map((name) => [name, env[name]]))
  return { ok: true, values }
}

/**
 * Duplicated from `packages/config/src/env.ts`'s own `stripTrailingSlashes`
 * — see this file's module comment for why it is not imported instead.
 */
export function stripTrailingSlashes(url) {
  return url.replace(/\/+$/, '')
}

/** Derives the redirect URI the same way `apps/api/src/index.ts` does: `${PUBLIC_APP_URL}/discord/callback`, with `PUBLIC_APP_URL` trailing-slash-normalised. */
export function deriveRedirectUri(publicAppUrl) {
  return `${stripTrailingSlashes(publicAppUrl)}/discord/callback`
}

/** Decode a URI component, falling back to the original string on a malformed escape rather than throwing. */
function decodeSafe(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Parse a string as a URL, returning `null` instead of throwing on a malformed one. */
function tryParseUrl(value) {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/**
 * The WHATWG `URL` parser lowercases the host on `.host`/`.href` (per the
 * URL spec), so a raw string is the only way left to see whether the
 * *original* string used a different letter case there — needed to tell
 * "host case differs" apart from "hosts are identical". Returns `null` if
 * the string does not look like `scheme://host...`.
 */
function extractRawHost(value) {
  const match = value.match(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\/([^/?#]*)/)
  return match ? match[1] : null
}

/**
 * Compares `expected` against a single registered entry and classifies the
 * relationship, or returns `null` if the two are unrelated (no near-miss
 * explanation applies). Mirrors Discord's own matching rules: percent-
 * encoding is decoded before comparison, hosts are case-insensitive, paths
 * are case-sensitive.
 */
function compareOne(expected, registered) {
  if (expected === registered) {
    return { kind: 'match', registered }
  }

  // Percent-encoding: Discord decodes both sides before matching, so a
  // registered entry that spells the same URI with `%2F` (or similar) is a
  // real match, not a mismatch of any kind.
  if (decodeSafe(expected) === decodeSafe(registered)) {
    return { kind: 'match', registered }
  }

  const expectedUrl = tryParseUrl(expected)
  const registeredUrl = tryParseUrl(registered)
  if (!expectedUrl || !registeredUrl) return null

  const rawExpectedHost = extractRawHost(expected)
  const rawRegisteredHost = extractRawHost(registered)
  const hostsEqualCI =
    expectedUrl.host.toLowerCase() === registeredUrl.host.toLowerCase()
  const rawHostsDiffer = rawExpectedHost !== rawRegisteredHost
  const pathsEqual =
    decodeSafe(expectedUrl.pathname) === decodeSafe(registeredUrl.pathname)
  const pathsEqualCI =
    decodeSafe(expectedUrl.pathname).toLowerCase() ===
    decodeSafe(registeredUrl.pathname).toLowerCase()
  const schemesEqual = expectedUrl.protocol === registeredUrl.protocol

  // Host case only — hosts are case-insensitive, so this is a match, but
  // flagged with a warning rather than silently accepted, since it is still
  // worth an operator's attention.
  if (schemesEqual && hostsEqualCI && rawHostsDiffer && pathsEqual) {
    return {
      kind: 'match',
      registered,
      warning:
        'the registered host differs only in letter case from the derived one; hosts are case-insensitive, so this still matches',
    }
  }

  // Trailing slash on the path only, everything else identical.
  const strippedExpectedPath = expectedUrl.pathname.replace(/\/+$/, '')
  const strippedRegisteredPath = registeredUrl.pathname.replace(/\/+$/, '')
  if (
    schemesEqual &&
    hostsEqualCI &&
    expectedUrl.pathname !== registeredUrl.pathname &&
    strippedExpectedPath === strippedRegisteredPath
  ) {
    return {
      kind: 'near-miss',
      difference: 'trailing-slash',
      registered,
      message: 'differs only by a trailing slash on the path',
    }
  }

  // Scheme differs (http vs https), rest identical.
  if (!schemesEqual && hostsEqualCI && pathsEqual) {
    return {
      kind: 'near-miss',
      difference: 'scheme',
      registered,
      message: `scheme differs (${expectedUrl.protocol} vs ${registeredUrl.protocol})`,
    }
  }

  // www. vs apex host, rest identical.
  const expectedHost = expectedUrl.host.toLowerCase()
  const registeredHost = registeredUrl.host.toLowerCase()
  const isWwwVariant =
    expectedHost === `www.${registeredHost}` ||
    registeredHost === `www.${expectedHost}`
  if (schemesEqual && isWwwVariant && pathsEqual) {
    return {
      kind: 'near-miss',
      difference: 'www',
      registered,
      message: `host differs by a "www." prefix (${expectedUrl.host} vs ${registeredUrl.host})`,
    }
  }

  // Path case differs — unlike hosts, paths ARE case-sensitive, so this is
  // a real mismatch, not a warning.
  if (schemesEqual && hostsEqualCI && !pathsEqual && pathsEqualCI) {
    return {
      kind: 'near-miss',
      difference: 'path-case',
      registered,
      message: `path differs only in letter case (${expectedUrl.pathname} vs ${registeredUrl.pathname}), and paths are case-sensitive`,
    }
  }

  return null
}

/**
 * Compares the derived redirect URI against Discord's own `redirect_uris`
 * list and classifies the result — the part of this script worth testing
 * hardest. Returns a discriminated result:
 *   - `{ kind: 'empty' }` — the list is registered but has nothing in it.
 *   - `{ kind: 'match', registered, warning? }` — an exact match, or one
 *     Discord itself treats as equivalent (percent-encoding, host case).
 *   - `{ kind: 'near-miss', difference, registered, message }` — a specific,
 *     nameable difference from one registered entry.
 *   - `{ kind: 'absent', registered }` — a non-empty list with nothing
 *     close enough to explain as a near miss.
 */
export function classifyRedirectMismatch(expected, registered) {
  if (registered.length === 0) {
    return { kind: 'empty' }
  }

  const comparisons = registered.map((entry) => compareOne(expected, entry))

  const match = comparisons.find((c) => c && c.kind === 'match')
  if (match) return match

  const nearMiss = comparisons.find((c) => c && c.kind === 'near-miss')
  if (nearMiss) return nearMiss

  return { kind: 'absent', registered }
}

/**
 * `GET /applications/@me` with `Authorization: Bot <token>` — never throws;
 * every failure (a bad token, a network error, an unexpected shape) comes
 * back as `{ ok: false, ... }` so `main()` can print a readable line instead
 * of a stack trace. Never includes the token in the returned value.
 */
export async function fetchApplication(botToken, { fetchFn = fetch } = {}) {
  let response
  try {
    response = await fetchFn('https://discord.com/api/v10/applications/@me', {
      headers: { Authorization: `Bot ${botToken}` },
    })
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  let body
  try {
    body = await response.json()
  } catch {
    body = undefined
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: body && body.message ? body.message : `HTTP ${response.status}`,
    }
  }

  return { ok: true, application: body }
}

/** One human-readable report for the classifier's result. */
function describeClassification(expected, classification) {
  switch (classification.kind) {
    case 'match':
      return classification.warning
        ? `MATCH (with a warning): ${expected} is registered as ${classification.registered} — ${classification.warning}`
        : `MATCH: ${expected} is registered.`
    case 'near-miss':
      return (
        `NEAR MISS: ${expected} is not registered, but ${classification.registered} is close — ${classification.message}. ` +
        'Fix the registered entry in the Discord Developer Portal to match exactly.'
      )
    case 'absent':
      return (
        `MISMATCH: ${expected} is not in the registered redirect_uris list (${classification.registered.length} registered, none close): ` +
        classification.registered.join(', ')
      )
    case 'empty':
      return `MISMATCH: the application's redirect_uris list is registered but empty — ${expected} needs to be added.`
    default:
      return 'Unrecognised classification.'
  }
}

async function main() {
  const envCheck = readRequiredEnv(process.env)
  if (!envCheck.ok) {
    console.error(
      `Missing required environment variable(s): ${envCheck.missing.join(', ')}`
    )
    process.exitCode = 1
    return
  }
  const { BOT_APP_ID, BOT_TOKEN, PUBLIC_APP_URL } = envCheck.values

  const expected = deriveRedirectUri(PUBLIC_APP_URL)
  console.log(`Derived redirect URI: ${expected}`)
  console.log(`BOT_APP_ID (expected application): ${BOT_APP_ID}`)

  const applicationResult = await fetchApplication(BOT_TOKEN)
  if (!applicationResult.ok) {
    console.error(
      `Could not fetch the application from Discord: ${applicationResult.error}`
    )
    process.exitCode = 1
    return
  }

  const { application } = applicationResult
  console.log(
    `Discord application this token belongs to: ${application.id} (${application.name})`
  )
  if (String(application.id) !== String(BOT_APP_ID)) {
    console.warn(
      `WARNING: this application id (${application.id}) does not match BOT_APP_ID (${BOT_APP_ID}) — ` +
        'BOT_TOKEN and BOT_APP_ID may name different applications.'
    )
  }

  const registered = application.redirect_uris
  if (registered === undefined || registered === null) {
    console.log(
      'Could not verify: the API response does not expose redirect_uris ' +
        "(Discord's documented GET /applications/@me response does not always include it). " +
        `The Developer Portal is the only source of truth: https://discord.com/developers/applications/${BOT_APP_ID}/oauth2 — ` +
        `paste this exact string there: ${expected}`
    )
    process.exitCode = 0
    return
  }

  const classification = classifyRedirectMismatch(expected, registered)
  console.log(describeClassification(expected, classification))
  process.exitCode = classification.kind === 'match' ? 0 : 1
}

// Only run when invoked directly, so importing this module for tests (or
// from another script, the same shape `health-check.mjs` uses) never
// triggers a real network call.
if (process.argv[1] && process.argv[1].endsWith('check-discord-oauth.mjs')) {
  loadDotEnvOnce()
  main()
}
