/**
 * Polls the four processes' own `/health` endpoints (OPS-8, OPS-12) and
 * reports which ones are actually answering, not merely running — the same
 * distinction `apps/api`/`apps/bot`/`apps/worker`/`apps/mcp`'s own health
 * servers already draw (COST-5), used here rather than a second liveness
 * check invented for deployment or monitoring.
 *
 * Deliberately dependency-free from the workspace's own TypeScript packages
 * — `@bloombot/config` would give the real, validated port numbers, but
 * importing it means this script only works once the workspace has been
 * built, the same reason `scripts/dev.mjs`'s own module comment gives for
 * avoiding that import. The port defaults below are duplicated from
 * `packages/config/src/env.ts` on purpose, not read from it; a mismatch
 * between the two is what `scripts/health-check.test.mjs`'s
 * "matches packages/config's own defaults" case exists to catch.
 *
 * Used two ways:
 *   - `scripts/deploy.sh` (OPS-8) runs this once, after reloading the
 *     TypeScript processes, and rolls back the deploy if any of them is not
 *     `ok`.
 *   - `scripts/ops-monitor.mjs` (OPS-12) imports `checkAll`/`healthEndpoints`
 *     directly and polls continuously, watching for a transition rather than
 *     a single point-in-time answer.
 */

/** The port each process's health endpoint listens on, and the environment variable that overrides it — must track `packages/config/src/env.ts`. */
export const DEFAULT_HEALTH_PORTS = {
  api: { envVar: 'API_PORT', port: 3000 },
  bot: { envVar: 'BOT_HEALTH_PORT', port: 3001 },
  worker: { envVar: 'WORKER_HEALTH_PORT', port: 3002 },
  mcp: { envVar: 'MCP_PORT', port: 3003 },
}

/**
 * Build the four `{ name, url }` endpoints to poll, from an environment
 * object (defaults to `process.env`, injectable for tests). Every health
 * server binds to `127.0.0.1` only (each process's own module comment says
 * why), so this never has a reason to reach off the box it runs on.
 */
export function healthEndpoints(env = process.env) {
  return Object.entries(DEFAULT_HEALTH_PORTS).map(
    ([name, { envVar, port }]) => {
      const value = Number(env[envVar])
      const resolvedPort = Number.isInteger(value) && value > 0 ? value : port
      return { name, url: `http://127.0.0.1:${resolvedPort}/health` }
    }
  )
}

/**
 * Fetch one endpoint and report what happened — never throws. A process
 * that is not listening at all (crashed, not yet started) and a process
 * that answers `503` are both "not ok", but distinguished in the result so
 * a caller can say which.
 */
export async function checkEndpoint(
  endpoint,
  { fetchFn = fetch, timeoutMs = 3000 } = {}
) {
  try {
    const response = await fetchFn(endpoint.url, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    return {
      name: endpoint.name,
      url: endpoint.url,
      reachable: true,
      status: response.status,
      ok: response.status === 200,
      body,
    }
  } catch (error) {
    return {
      name: endpoint.name,
      url: endpoint.url,
      reachable: false,
      status: undefined,
      ok: false,
      body: undefined,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Check every endpoint concurrently. */
export function checkAll(endpoints, options) {
  return Promise.all(endpoints.map((e) => checkEndpoint(e, options)))
}

/** One human-readable line per result, for the CLI and for a notification body. */
export function describeResult(result) {
  if (result.ok) return `${result.name}: ok`
  if (result.reachable) return `${result.name}: responded ${result.status}`
  return `${result.name}: unreachable (${result.error})`
}

async function run() {
  const results = await checkAll(healthEndpoints())
  for (const result of results) console.log(describeResult(result))
  const allOk = results.every((r) => r.ok)
  process.exitCode = allOk ? 0 : 1
}

// Only run when invoked directly, so deploy.sh's and ops-monitor.mjs's own
// imports of `checkAll`/`healthEndpoints` above never trigger a network call.
if (process.argv[1] && process.argv[1].endsWith('health-check.mjs')) run()
