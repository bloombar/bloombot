/**
 * Shared with every spec that seeds `E2E_DATABASE_PATH` directly through
 * `@bloombot/db` — a *second* connection to the same file `apps/api`'s own
 * process already holds open (`admin-console.spec.ts`'s own module comment,
 * where this first lived, has the full "why"). SQLite's own "database is
 * locked" (`SQLITE_LOCKED`) is a different condition from "database is
 * busy" (`SQLITE_BUSY`) — `client.ts`'s own `busy_timeout` pragma governs
 * only the latter, so a genuine, if rare, lock contention between this
 * process's own writes and the live API process's (four Playwright workers
 * and one shared API process, all against one file) is not something that
 * pragma alone absorbs. Each call site wraps its own atomic write (a single
 * repo function, its own transaction) — safe to retry outright on this
 * specific condition, since a failed attempt commits nothing.
 *
 * Pulled out here (code review, WEB-54) rather than left as
 * `admin-console.spec.ts`'s own private helper: `mobile-viewport.spec.ts`
 * needs the identical wrapper for its own seeding, and copying it a second
 * time would leave two copies to keep in sync for one shared reason.
 */
export async function withRetry<T>(fn: () => T): Promise<T> {
  const attempts = 5
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return fn()
    } catch (error) {
      const locked =
        error instanceof Error && /database is locked/i.test(error.message)
      if (!locked || attempt === attempts) throw error
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt))
    }
  }
  throw new Error('unreachable')
}
