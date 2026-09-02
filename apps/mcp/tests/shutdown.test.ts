/**
 * `createShutdown` — closes the server then the database, and a second
 * signal (or the same one twice) is a no-op rather than a second teardown
 * racing the first, the identical guard `apps/bot/tests/shutdown.test.ts`
 * and `apps/worker/tests/shutdown.test.ts` already pin for their own
 * `createShutdown`. Every dependency here is a plain `vi.fn()`, no real
 * HTTP server or database in the loop.
 */

import { describe, expect, it, vi } from 'vitest'

import { createShutdown, type ShutdownDependencies } from '../src/shutdown.js'

function makeDeps(
  overrides: Partial<ShutdownDependencies> = {}
): ShutdownDependencies & {
  setShuttingDown: ReturnType<typeof vi.fn>
  closeServer: ReturnType<typeof vi.fn>
  closeDb: ReturnType<typeof vi.fn>
} {
  return {
    logger: { info: vi.fn() },
    setShuttingDown: vi.fn(),
    closeServer: vi.fn().mockResolvedValue(undefined),
    closeDb: vi.fn(),
    ...overrides,
  } as ShutdownDependencies & {
    setShuttingDown: ReturnType<typeof vi.fn>
    closeServer: ReturnType<typeof vi.fn>
    closeDb: ReturnType<typeof vi.fn>
  }
}

describe('createShutdown', () => {
  it('sets shutting-down, then closes the server, then the database, in that order', async () => {
    const deps = makeDeps()
    const order: string[] = []
    deps.setShuttingDown.mockImplementation(() => order.push('setShuttingDown'))
    deps.closeServer.mockImplementation(async () => {
      order.push('closeServer')
    })
    deps.closeDb.mockImplementation(() => order.push('closeDb'))

    await createShutdown(deps)('SIGTERM')

    expect(order).toEqual(['setShuttingDown', 'closeServer', 'closeDb'])
  })

  it('flips shutting-down before closing anything — /health must stop reporting ready before the server (and so, eventually, the process) actually goes away', async () => {
    const deps = makeDeps()
    deps.closeServer.mockImplementation(async () => {
      expect(deps.setShuttingDown).toHaveBeenCalled()
    })

    await createShutdown(deps)('SIGTERM')

    expect(deps.setShuttingDown).toHaveBeenCalledTimes(1)
  })

  it('logs the signal it was called with', async () => {
    const deps = makeDeps()

    await createShutdown(deps)('SIGINT')

    expect(deps.logger.info).toHaveBeenCalledWith(
      { signal: 'SIGINT' },
      'apps/mcp: shutting down'
    )
  })

  it('is a no-op on a second call, whether the same signal or a different one', async () => {
    const deps = makeDeps()
    const shutdown = createShutdown(deps)

    await shutdown('SIGTERM')
    await shutdown('SIGINT')

    expect(deps.closeServer).toHaveBeenCalledTimes(1)
    expect(deps.closeDb).toHaveBeenCalledTimes(1)
  })

  it('a second call while the first is still in flight is also a no-op', async () => {
    const deps = makeDeps()
    let resolveClose: () => void = () => {}
    deps.closeServer.mockImplementation(
      () => new Promise<void>((resolve) => (resolveClose = resolve))
    )
    const shutdown = createShutdown(deps)

    const first = shutdown('SIGTERM')
    const second = shutdown('SIGTERM')
    resolveClose()
    await Promise.all([first, second])

    expect(deps.closeDb).toHaveBeenCalledTimes(1)
  })
})
