/**
 * COST-5 — "make the three processes' health observable in one place: the
 * gateway connection, the queue depth, the model provider's error rate."
 *
 * A plain function, not an `Action` (`types.ts`) registered through
 * `ActionRegistry`/`dispatch.ts` — the same reasoning `repos/cost-ledger.ts`'s
 * own module comment gives for `listOrganizationTotals`: `dispatch.ts`'s
 * `DispatchContext.organizationId` names the one organization a caller is
 * acting within, and this reads the platform's own operational state, not
 * any organization's data at all. It lives in this package (rather than,
 * say, `packages/db`, which owns none of the HTTP this needs) because this
 * package is already the platform's own "read" layer — the brief for this
 * slice is explicit that "a read action is fine; it does not need a
 * dashboard."
 *
 * Each of the three processes already answers its own health check over
 * loopback HTTP (`apps/bot/src/health.ts`, `apps/worker/src/health.ts`,
 * `apps/api/src/health.ts`) — this only aggregates those three responses
 * into one report, reaching no database and no provider of its own. No
 * network beyond loopback: every URL a real caller supplies here points at
 * `127.0.0.1`, the same "these endpoints have no reason to be reachable
 * from outside the machine they run on" discipline each of those three
 * health servers already holds itself to.
 */

/** One process's own health, as this function observed it. */
export interface ProcessHealth {
  /**
   * Whether the process actually answered at all. `false` — not `healthy:
   * false`, not omitted — is COST-5's own "reports a process it cannot
   * reach as unreachable rather than healthy": a process that never
   * responds (crashed, still starting, a firewall in the way) must not be
   * indistinguishable from one that responded `503`.
   */
  reachable: boolean
  /** The process's own health body, whatever shape that process's own health server returns — `undefined` when `reachable` is `false`, since there is nothing to report. */
  status?: unknown
}

/** One report covering all three processes. */
export interface PlatformHealthReport {
  bot: ProcessHealth
  worker: ProcessHealth
  api: ProcessHealth
}

/** Where to reach each process's own health endpoint — always loopback in a real deployment (this file's own module comment). */
export interface CheckPlatformHealthOptions {
  botHealthUrl: string
  workerHealthUrl: string
  apiHealthUrl: string
  /** Defaults to the global `fetch` — overridable so a test can supply a fake with no real network, the same convention `@bloombot/openai`'s own HTTP client uses. */
  fetchFn?: typeof fetch
  /** How long to wait for one process to answer before treating it as unreachable. Defaults to 2s — long enough for a real loopback round trip, short enough that one stuck process does not stall the whole report. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 2_000

/** Fetch one process's own health endpoint. Any failure — a refused connection, a timeout, an unparsable body — is `{ reachable: false }`, never thrown: one process being down must not stop this function from reporting the other two. */
async function checkOneProcess(
  url: string,
  fetchFn: typeof fetch,
  timeoutMs: number
): Promise<ProcessHealth> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchFn(url, { signal: controller.signal })
    // A process's own health server can legitimately answer `503` (not
    // ready) — that is still a real, reachable response, distinct from no
    // response at all, so `response.ok` is not the check here.
    const status: unknown = await response.json()
    return { reachable: true, status }
  } catch {
    // Anything at all — connection refused, aborted by the timeout above,
    // an invalid JSON body — reads the same way: this process could not be
    // reached, or could not be understood, either of which COST-5 treats
    // as "unreachable" rather than guessing which.
    return { reachable: false }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * COST-5's own read: the bot's gateway connection and model error rate, the
 * worker's queue depth, and the API's own readiness — one report, one call,
 * so an operator does not have to poll three separate endpoints (or read
 * three separate log files) to notice a failure before a student reports
 * it.
 */
export async function checkPlatformHealth(
  options: CheckPlatformHealthOptions
): Promise<PlatformHealthReport> {
  const fetchFn = options.fetchFn ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const [bot, worker, api] = await Promise.all([
    checkOneProcess(options.botHealthUrl, fetchFn, timeoutMs),
    checkOneProcess(options.workerHealthUrl, fetchFn, timeoutMs),
    checkOneProcess(options.apiHealthUrl, fetchFn, timeoutMs),
  ])

  return { bot, worker, api }
}
