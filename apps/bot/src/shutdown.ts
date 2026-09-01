/**
 * SURF-7's shutdown path — closes the gateway and the database cleanly
 * rather than leaving the socket to time out, and drains work already in
 * flight instead of dropping it mid-answer.
 *
 * Finding 7 of the SURF-1 rework: `client.destroy()` returns a promise that
 * used to go unawaited before `process.exit(0)`, racing the close handshake
 * against the exit — exactly what SURF-7's own comment says this path
 * exists to avoid. There was also no drain at all: a signal arriving
 * mid-model-call lost the answer and the transcript reply while the day's
 * usage slot stayed spent (it is reserved before the model is asked,
 * `@bloombot/core`'s own CORE-3). And a second signal raced a second
 * teardown against the first with no guard at all.
 *
 * Every dependency here is a small function rather than a `Client`/`Database`
 * object, so this is testable with plain `vi.fn()`s and no discord.js or
 * `@bloombot/db` object in the loop.
 */

/** Tracks promises currently "in flight" so shutdown can wait for them instead of abandoning one mid-answer. */
export class InFlightTracker {
  private readonly pending = new Set<Promise<unknown>>()

  /** How many promises are currently tracked — read by tests, not by shutdown itself. */
  get size(): number {
    return this.pending.size
  }

  /** Register `promise` as in flight; stops tracking it once it settles, either way. Returns `promise` unchanged, so a caller can still await or ignore it as it already did. */
  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise)
    const untrack = () => this.pending.delete(promise)
    promise.then(untrack, untrack)
    return promise
  }

  /**
   * Resolves once every currently-tracked promise has settled, or
   * `timeoutMs` has elapsed — whichever comes first, so one wedged handler
   * cannot hang shutdown forever (see `docs/DECISIONS.md` D-17's "Limits").
   */
  async drain(timeoutMs: number): Promise<void> {
    if (this.pending.size === 0) return
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      void Promise.allSettled([...this.pending]).then(finish)
    })
  }
}

export interface ShutdownDependencies {
  logger: { info: (fields: Record<string, unknown>, message: string) => void }
  /** Stops the health endpoint from reporting a connection that is going away — set before anything async runs. */
  setDisconnected: () => void
  /** Closes the discord.js gateway connection cleanly. */
  destroyClient: () => Promise<void>
  /** Closes the database connection. */
  closeDb: () => void
  /** Stops the health server. */
  closeHealth: () => Promise<void>
  /** Tracks in-flight `onMessageCreate` calls so shutdown can wait for them. */
  inFlight: InFlightTracker
  /** Bounded wait for in-flight handlers to settle. Defaults to 5000ms. */
  drainTimeoutMs?: number
}

/**
 * Builds the one shutdown function this process calls from both `SIGINT`
 * and `SIGTERM`. A second call — a second signal, or the same one twice —
 * is a no-op rather than a second teardown racing the first: `shuttingDown`
 * is shared state across every call this closure ever makes, not reset per
 * signal type.
 */
export function createShutdown(
  deps: ShutdownDependencies
): (signal: string) => Promise<void> {
  let shuttingDown = false
  return async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    deps.logger.info({ signal }, 'apps/bot: shutting down')
    deps.setDisconnected()
    await deps.inFlight.drain(deps.drainTimeoutMs ?? 5000)
    await deps.destroyClient()
    deps.closeDb()
    await deps.closeHealth()
  }
}
