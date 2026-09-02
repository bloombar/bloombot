/**
 * This process's own shutdown path — closes the HTTP server and the
 * database cleanly rather than exiting under load, and makes a second
 * signal (or the same one twice) a no-op rather than a second teardown
 * racing the first — the identical guard `apps/bot`'s own `createShutdown`
 * (`apps/bot/src/shutdown.ts`) and `apps/worker`'s own `createShutdown`
 * (`apps/worker/src/shutdown.ts`) already hold themselves to. Split into
 * its own file, matching those two, rather than inlined in `index.ts` the
 * way `apps/api`'s simpler shutdown is — this is testable with plain
 * `vi.fn()`s and no real server or database in the loop.
 */

export interface ShutdownDependencies {
  logger: { info: (fields: Record<string, unknown>, message: string) => void }
  /**
   * Flips `index.ts`'s own `shuttingDown` flag, read by `server.ts`'s own
   * `/health` route on every request (`buildApp`'s own `isShuttingDown`
   * parameter) — rework finding: `/health` used to keep reporting
   * `ready: true` for this process's entire teardown window. Called first,
   * before anything else here runs, the same "mark not-ready before
   * touching anything that takes time" ordering `apps/bot`'s own
   * `createShutdown` (`setDisconnected`) and `apps/worker`'s own
   * (`setShuttingDown`) already hold themselves to.
   */
  setShuttingDown: () => void
  /** Stops the HTTP server from accepting new connections and resolves once every existing one has finished. */
  closeServer: () => Promise<void>
  /** Closes the database connection. */
  closeDb: () => void
}

/**
 * Builds the one shutdown function this process calls from both `SIGINT`
 * and `SIGTERM`.
 */
export function createShutdown(
  deps: ShutdownDependencies
): (signal: string) => Promise<void> {
  let shuttingDown = false
  return async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    deps.setShuttingDown()
    deps.logger.info({ signal }, 'apps/mcp: shutting down')
    await deps.closeServer()
    deps.closeDb()
  }
}
