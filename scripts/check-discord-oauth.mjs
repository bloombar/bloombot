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
 * The WHATWG `URL` parser normalises the authority away from a form that
 * still lets two, genuinely different URIs read as identical: it lowercases
 * the hostname, and it *drops* an explicit default port (`https://host:443`
 * serialises with the same `.host` as `https://host`) and userinfo is
 * simply absent from `.host` entirely. `url.host` alone therefore cannot
 * tell "the registered entry differs only by letter case" apart from "the
 * registered entry adds an explicit default port" or "...adds userinfo" —
 * rework round 1 found this the hard way: it let `:443` and `user:pw@`
 * differences read as a case-only match. This parses the *raw* authority
 * substring instead, keeping port and userinfo exactly as written, so
 * `compareOne` below can tell all three apart. Returns `null` if `value`
 * does not look like `scheme://authority...`.
 */
function parseRawAuthority(value) {
  const match = value.match(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\/([^/?#]*)/)
  if (!match) return null
  let rest = match[1]

  let userinfo = null
  const atIndex = rest.lastIndexOf('@')
  if (atIndex !== -1) {
    userinfo = rest.slice(0, atIndex)
    rest = rest.slice(atIndex + 1)
  }

  // An IPv6 literal (`[::1]:443`) carries its own colons, so the port has
  // to be split off after the closing bracket rather than at the first
  // colon — Discord redirect URIs are never IPv6 in practice, but this
  // keeps the split correct rather than merely "usually correct".
  let hostname = rest
  let port = null
  if (rest.startsWith('[')) {
    const closeBracket = rest.indexOf(']')
    hostname = rest.slice(0, closeBracket + 1)
    const afterBracket = rest.slice(closeBracket + 1)
    if (afterBracket.startsWith(':')) port = afterBracket.slice(1)
  } else {
    const colonIndex = rest.indexOf(':')
    if (colonIndex !== -1) {
      hostname = rest.slice(0, colonIndex)
      port = rest.slice(colonIndex + 1)
    }
  }

  return { userinfo, hostname, port }
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

  const expectedAuthority = parseRawAuthority(expected)
  const registeredAuthority = parseRawAuthority(registered)
  const hostsEqualCI =
    expectedUrl.host.toLowerCase() === registeredUrl.host.toLowerCase()
  const pathsEqual =
    decodeSafe(expectedUrl.pathname) === decodeSafe(registeredUrl.pathname)
  const pathsEqualCI =
    decodeSafe(expectedUrl.pathname).toLowerCase() ===
    decodeSafe(registeredUrl.pathname).toLowerCase()
  const schemesEqual = expectedUrl.protocol === registeredUrl.protocol

  // Everything the raw authority carries, compared against the case-
  // insensitive hostname alone — real, per-field detail `url.host` itself
  // throws away (rework round 1's own module comment on `parseRawAuthority`
  // has the full reasoning for why this cannot use `url.host`/`.hostname`).
  const hostnamesEqualCI =
    expectedAuthority &&
    registeredAuthority &&
    expectedAuthority.hostname.toLowerCase() ===
      registeredAuthority.hostname.toLowerCase()
  const userinfoDiffers =
    expectedAuthority &&
    registeredAuthority &&
    expectedAuthority.userinfo !== registeredAuthority.userinfo
  const portDiffers =
    expectedAuthority &&
    registeredAuthority &&
    expectedAuthority.port !== registeredAuthority.port

  // Host case only, and nothing else about the authority differs — hosts
  // are case-insensitive, so this is a match, but flagged with a warning
  // rather than silently accepted, since it is still worth an operator's
  // attention.
  if (
    schemesEqual &&
    pathsEqual &&
    hostnamesEqualCI &&
    !userinfoDiffers &&
    !portDiffers &&
    expectedAuthority.hostname !== registeredAuthority.hostname
  ) {
    return {
      kind: 'match',
      registered,
      warning:
        'the registered host differs only in letter case from the derived one; hosts are case-insensitive, so this still matches',
    }
  }

  // Userinfo present on one side but not the other (or different) — a real
  // difference in the URI Discord compares byte-for-byte, not something it
  // normalises away, so this must never read as a match.
  if (schemesEqual && pathsEqual && hostnamesEqualCI && userinfoDiffers) {
    return {
      kind: 'near-miss',
      difference: 'userinfo',
      registered,
      message: `registered entry ${registeredAuthority.userinfo !== null ? 'includes' : 'omits'} userinfo (\`user:pass@\`) that the derived URI does not`,
    }
  }

  // An explicit port — including one that merely repeats the scheme's own
  // default, like `:443` on `https` — that `url.host` itself silently drops
  // on normalisation. Still a literal difference in what gets registered
  // and what gets sent, so still worth naming rather than waving through.
  if (schemesEqual && pathsEqual && hostnamesEqualCI && portDiffers) {
    return {
      kind: 'near-miss',
      difference: 'port',
      registered,
      message: `port differs (expected: ${expectedAuthority.port ?? 'none specified'}, registered: ${registeredAuthority.port ?? 'none specified'})`,
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
  // `main()` only ever calls this after confirming `redirect_uris` is
  // present (a `null`/`undefined` list is its own, earlier "could not
  // verify" outcome — see that function below), so a non-array here is
  // unreachable from the CLI. Still made total over its own documented
  // input rather than left to throw: an exported pure function should
  // degrade the same way for any caller, not only the one this script
  // currently has.
  if (!Array.isArray(registered) || registered.length === 0) {
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
 * every failure (a bad token, a network error, an unexpected shape, or a
 * 200 whose body cannot be parsed as JSON — rework round 1: this last one
 * used to slip through as `{ ok: true, application: undefined }`, which
 * `main()` then read `.id` off, an unhandled rejection instead of the
 * readable degradation every other failure here gets) comes back as
 * `{ ok: false, ... }` so a caller can print a readable line instead of a
 * stack trace. Never includes the token in the returned value.
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
  let bodyParseFailed = false
  try {
    body = await response.json()
  } catch {
    bodyParseFailed = true
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: body && body.message ? body.message : `HTTP ${response.status}`,
    }
  }

  if (bodyParseFailed || body === undefined || body === null) {
    return {
      ok: false,
      status: response.status,
      error: `Discord returned HTTP ${response.status} with a body that could not be parsed as JSON`,
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

/**
 * The whole outcome/exit-code mapping this script exists to produce, as a
 * pure function of an environment object and an injectable `fetchFn` — no
 * I/O of its own. Rework round 1: nothing pinned this mapping before,
 * including the "could not verify" outcome the brief calls out as its own,
 * distinct, non-failing result (exit 0, neither "verified" nor
 * "mismatch") — a regression flipping any of these five outcomes would
 * have passed the suite as it stood. `main()` below just prints `logs`,
 * `warnings` and `errors` in order and exits with `exitCode`, so this is
 * the only place the exit-code contract is decided.
 */
export async function determineOutcome(env, { fetchFn = fetch } = {}) {
  const envCheck = readRequiredEnv(env)
  if (!envCheck.ok) {
    return {
      exitCode: 1,
      logs: [],
      warnings: [],
      errors: [
        `Missing required environment variable(s): ${envCheck.missing.join(', ')}`,
      ],
    }
  }
  const { BOT_APP_ID, BOT_TOKEN, PUBLIC_APP_URL } = envCheck.values

  const expected = deriveRedirectUri(PUBLIC_APP_URL)
  const logs = [
    `Derived redirect URI: ${expected}`,
    `BOT_APP_ID (expected application): ${BOT_APP_ID}`,
  ]

  const applicationResult = await fetchApplication(BOT_TOKEN, { fetchFn })
  if (!applicationResult.ok) {
    return {
      exitCode: 1,
      logs,
      warnings: [],
      errors: [
        `Could not fetch the application from Discord: ${applicationResult.error}`,
      ],
    }
  }

  const { application } = applicationResult
  logs.push(
    `Discord application this token belongs to: ${application.id} (${application.name})`
  )
  const warnings = []
  // BOT_TOKEN and BOT_APP_ID naming different applications is common
  // enough (cause 3 in this file's own module comment) to call out here —
  // but note this warning does NOT change the exit code below: if the
  // token's own application happens to have the derived URI registered,
  // this still exits 0. A 0 here is "this token's application is fine," not
  // "production, as configured with BOT_APP_ID, is fine" — see
  // `docs/DECISIONS.md`'s D-93 entry.
  if (String(application.id) !== String(BOT_APP_ID)) {
    warnings.push(
      `WARNING: this application id (${application.id}) does not match BOT_APP_ID (${BOT_APP_ID}) — ` +
        'BOT_TOKEN and BOT_APP_ID may name different applications.'
    )
  }

  const registered = application.redirect_uris
  if (registered === undefined || registered === null) {
    logs.push(
      'Could not verify: the API response does not expose redirect_uris ' +
        "(Discord's documented GET /applications/@me response does not always include it). " +
        `The Developer Portal is the only source of truth: https://discord.com/developers/applications/${BOT_APP_ID}/oauth2 — ` +
        `paste this exact string there: ${expected}`
    )
    return { exitCode: 0, logs, warnings, errors: [] }
  }

  const classification = classifyRedirectMismatch(expected, registered)
  logs.push(describeClassification(expected, classification))
  return {
    exitCode: classification.kind === 'match' ? 0 : 1,
    logs,
    warnings,
    errors: [],
  }
}

async function main() {
  const outcome = await determineOutcome(process.env)
  for (const line of outcome.logs) console.log(line)
  for (const warning of outcome.warnings) console.warn(warning)
  for (const error of outcome.errors) console.error(error)
  process.exitCode = outcome.exitCode
}

// Only run when invoked directly, so importing this module for tests (or
// from another script, the same shape `health-check.mjs` uses) never
// triggers a real network call.
if (process.argv[1] && process.argv[1].endsWith('check-discord-oauth.mjs')) {
  loadDotEnvOnce()
  main()
}
