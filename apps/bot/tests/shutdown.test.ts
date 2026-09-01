/**
 * `createShutdown`/`InFlightTracker` (finding 7 of the SURF-1 rework): the
 * gateway close is awaited before the process exits, in-flight handlers are
 * drained with a bounded wait rather than abandoned mid-answer, and a second
 * signal is a no-op rather than a second teardown racing the first. Every
 * dependency here is a plain `vi.fn()` — no discord.js `Client`, no
 * `@bloombot/db` `Database`.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  createShutdown,
  InFlightTracker,
  type ShutdownDependencies,
} from '../src/shutdown.js'

/** Builds a fresh set of spies for one test, overridable per test. */
function makeDeps(
  overrides: Partial<ShutdownDependencies> = {}
): ShutdownDependencies & {
  destroyClient: ReturnType<typeof vi.fn>
  closeDb: ReturnType<typeof vi.fn>
  closeHealth: ReturnType<typeof vi.fn>
  setDisconnected: ReturnType<typeof vi.fn>
} {
  return {
    logger: { info: vi.fn() },
    setDisconnected: vi.fn(),
    destroyClient: vi.fn().mockResolvedValue(undefined),
    closeDb: vi.fn(),
    closeHealth: vi.fn().mockResolvedValue(undefined),
    inFlight: new InFlightTracker(),
    ...overrides,
  } as ShutdownDependencies & {
    destroyClient: ReturnType<typeof vi.fn>
    closeDb: ReturnType<typeof vi.fn>
    closeHealth: ReturnType<typeof vi.fn>
    setDisconnected: ReturnType<typeof vi.fn>
  }
}

describe('createShutdown (finding 7)', () => {
  it('disconnects, drains, destroys the client, closes the database, then closes the health server — in that order', async () => {
    const deps = makeDeps()
    const order: string[] = []
    deps.setDisconnected.mockImplementation(() => order.push('disconnect'))
    deps.destroyClient.mockImplementation(async () => {
      order.push('destroyClient')
    })
    deps.closeDb.mockImplementation(() => order.push('closeDb'))
    deps.closeHealth.mockImplementation(async () => {
      order.push('closeHealth')
    })

    const shutdown = createShutdown(deps)
    await shutdown('SIGTERM')

    expect(order).toEqual([
      'disconnect',
      'destroyClient',
      'closeDb',
      'closeHealth',
    ])
  })

  // The regression this rework fixes: `client.destroy()`'s own promise used
  // to go unawaited, racing the close handshake against `process.exit(0)`.
  it('awaits destroyClient before closeDb runs', async () => {
    const deps = makeDeps()
    let destroyResolved = false
    deps.destroyClient.mockImplementation(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            destroyResolved = true
            resolve()
          }, 10)
        )
    )
    deps.closeDb.mockImplementation(() => {
      expect(destroyResolved).toBe(true)
    })

    await createShutdown(deps)('SIGTERM')

    expect(deps.closeDb).toHaveBeenCalledTimes(1)
  })

  // A second signal — the same one twice, or a different one — must not run
  // the teardown again.
  it('is a no-op on a second call, whether the same signal or a different one', async () => {
    const deps = makeDeps()
    const shutdown = createShutdown(deps)

    await shutdown('SIGTERM')
    await shutdown('SIGINT')

    expect(deps.destroyClient).toHaveBeenCalledTimes(1)
    expect(deps.closeDb).toHaveBeenCalledTimes(1)
    expect(deps.closeHealth).toHaveBeenCalledTimes(1)
  })

  it('waits for an in-flight handler to settle before destroying the client', async () => {
    const deps = makeDeps()
    let handlerSettled = false
    deps.inFlight.track(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          handlerSettled = true
          resolve()
        }, 10)
      )
    )
    deps.destroyClient.mockImplementation(async () => {
      expect(handlerSettled).toBe(true)
    })

    await createShutdown(deps)('SIGTERM')

    expect(deps.destroyClient).toHaveBeenCalledTimes(1)
  })

  // The bounded half of the drain: a handler that never settles must not
  // hang shutdown forever.
  it('gives up waiting for a wedged handler once the drain timeout elapses', async () => {
    const deps = makeDeps({ drainTimeoutMs: 20 })
    deps.inFlight.track(new Promise<void>(() => {})) // never resolves

    const startedAt = Date.now()
    await createShutdown(deps)('SIGTERM')
    const elapsedMs = Date.now() - startedAt

    expect(deps.destroyClient).toHaveBeenCalledTimes(1)
    // Generous upper bound — this only proves shutdown did not wait for the
    // handler indefinitely, not that it returned at exactly 20ms.
    expect(elapsedMs).toBeLessThan(1000)
  })
})

describe('InFlightTracker', () => {
  it('stops tracking a promise once it settles, success or failure', async () => {
    const tracker = new InFlightTracker()
    const ok = tracker.track(Promise.resolve('ok'))
    const failed = tracker.track(
      Promise.reject(new Error('boom')).catch(() => 'handled')
    )

    await Promise.all([ok, failed])
    // Both promises above already attach their own rejection handler
    // (`.catch`) before `track` sees them, so `track`'s own internal
    // `.then(untrack, untrack)` chain never itself produces an unhandled
    // rejection.
    await new Promise((resolve) => setTimeout(resolve, 0)) // let the untrack microtask run

    expect(tracker.size).toBe(0)
  })

  it('drain resolves immediately when nothing is in flight', async () => {
    const tracker = new InFlightTracker()
    const startedAt = Date.now()

    await tracker.drain(5000)

    expect(Date.now() - startedAt).toBeLessThan(100)
  })
})
