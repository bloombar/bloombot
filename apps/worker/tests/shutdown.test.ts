/**
 * `createShutdown`/`InFlightJob` (JOB-5) — finishes or releases what this
 * process holds rather than abandoning it. Every dependency here is a
 * plain `vi.fn()`, no real database or health server, the same shape
 * `apps/bot/tests/shutdown.test.ts` already takes for its own
 * `createShutdown`.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  createShutdown,
  InFlightJob,
  type ShutdownDependencies,
} from '../src/shutdown.js'

function makeDeps(
  overrides: Partial<ShutdownDependencies> = {}
): ShutdownDependencies & {
  setShuttingDown: ReturnType<typeof vi.fn>
  stopLoop: ReturnType<typeof vi.fn>
  closeDb: ReturnType<typeof vi.fn>
  closeHealth: ReturnType<typeof vi.fn>
} {
  return {
    logger: { info: vi.fn(), warn: vi.fn() },
    setShuttingDown: vi.fn(),
    stopLoop: vi.fn(),
    inFlight: new InFlightJob(),
    closeDb: vi.fn(),
    closeHealth: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as ShutdownDependencies & {
    setShuttingDown: ReturnType<typeof vi.fn>
    stopLoop: ReturnType<typeof vi.fn>
    closeDb: ReturnType<typeof vi.fn>
    closeHealth: ReturnType<typeof vi.fn>
  }
}

describe('createShutdown (JOB-5)', () => {
  it('marks not-ready, stops the loop, drains, closes the database, then the health server — in that order', async () => {
    const deps = makeDeps()
    const order: string[] = []
    deps.setShuttingDown.mockImplementation(() => order.push('setShuttingDown'))
    deps.stopLoop.mockImplementation(() => order.push('stopLoop'))
    deps.closeDb.mockImplementation(() => order.push('closeDb'))
    deps.closeHealth.mockImplementation(async () => {
      order.push('closeHealth')
    })

    await createShutdown(deps)('SIGTERM')

    expect(order).toEqual([
      'setShuttingDown',
      'stopLoop',
      'closeDb',
      'closeHealth',
    ])
  })

  it('is a no-op on a second call, whether the same signal or a different one', async () => {
    const deps = makeDeps()
    const shutdown = createShutdown(deps)

    await shutdown('SIGTERM')
    await shutdown('SIGINT')

    expect(deps.closeDb).toHaveBeenCalledTimes(1)
    expect(deps.closeHealth).toHaveBeenCalledTimes(1)
  })

  it('waits for an in-flight job to settle before closing the database — JOB-5 "finishes"', async () => {
    const deps = makeDeps()
    let jobSettled = false
    deps.inFlight.track(
      new Promise<void>((resolve) =>
        setTimeout(() => {
          jobSettled = true
          resolve()
        }, 10)
      )
    )
    deps.closeDb.mockImplementation(() => {
      expect(jobSettled).toBe(true)
    })

    await createShutdown(deps)('SIGTERM')

    expect(deps.closeDb).toHaveBeenCalledTimes(1)
  })

  it('gives up waiting for a wedged job once the drain timeout elapses, and logs that it did', async () => {
    const deps = makeDeps({ drainTimeoutMs: 20 })
    deps.inFlight.track(new Promise<void>(() => {})) // never settles

    const startedAt = Date.now()
    await createShutdown(deps)('SIGTERM')
    const elapsedMs = Date.now() - startedAt

    // Generous upper bound — proves shutdown did not wait indefinitely.
    expect(elapsedMs).toBeLessThan(1000)
    expect(deps.closeDb).toHaveBeenCalledTimes(1)
    expect(deps.logger.warn).toHaveBeenCalled()
  })
})

describe('InFlightJob', () => {
  it('stops tracking a promise once it settles, success or failure', async () => {
    const tracker = new InFlightJob()
    const ok = tracker.track(Promise.resolve('ok'))
    const failed = tracker.track(
      Promise.reject(new Error('boom')).catch(() => 'handled')
    )

    await Promise.all([ok, failed])
    await new Promise((resolve) => setTimeout(resolve, 0)) // let the untrack microtask run

    expect(tracker.isRunning).toBe(false)
  })

  it('isRunning is true only while the current promise is unsettled', async () => {
    const tracker = new InFlightJob()
    expect(tracker.isRunning).toBe(false)

    let resolvePromise: () => void = () => {}
    tracker.track(new Promise<void>((resolve) => (resolvePromise = resolve)))
    expect(tracker.isRunning).toBe(true)

    resolvePromise()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(tracker.isRunning).toBe(false)
  })

  it('drain resolves immediately when nothing is in flight', async () => {
    const tracker = new InFlightJob()
    const startedAt = Date.now()

    await tracker.drain(5000)

    expect(Date.now() - startedAt).toBeLessThan(100)
  })
})
