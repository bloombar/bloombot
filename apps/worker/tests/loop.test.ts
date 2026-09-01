/**
 * `createWorkerLoop` (JOB-5's "claim, run, complete or fail, sleep,
 * repeat") — driven with a stand-in `runOnce` and a controllable `sleep`,
 * no real database, timer or handler. Every test below stops the loop
 * deterministically (from inside a mock, at a known call count) rather than
 * racing it against a wall-clock wait — `sleep` here is a `vi.fn()`
 * resolving on the next microtask, so a loop this test forgot to stop would
 * otherwise spin as fast as the event loop allows and exhaust memory before
 * any `setTimeout`-based assertion ever got to run.
 */

import { describe, expect, it, vi } from 'vitest'

import { createWorkerLoop } from '../src/loop.js'
import { InFlightJob } from '../src/shutdown.js'

describe('createWorkerLoop', () => {
  it('claims once, finds nothing, sleeps for the configured interval, and stops once stop() is called', async () => {
    const runOnce = vi.fn().mockResolvedValue({ outcome: 'empty' })
    const sleep = vi.fn().mockImplementation(async () => {
      loop.stop()
    })
    const loop = createWorkerLoop({
      runOnce,
      pollIntervalMs: 50,
      inFlight: new InFlightJob(),
      sleep,
    })

    await loop.run()

    expect(runOnce).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(50)
  })

  it('does not sleep after an iteration that actually ran something', async () => {
    let call = 0
    const sleep = vi.fn().mockResolvedValue(undefined)
    const runOnce = vi.fn().mockImplementation(async () => {
      call += 1
      if (call === 1) return { outcome: 'succeeded' }
      // Stops the loop from the second iteration onward, so this test never
      // depends on the event loop's own timing to end.
      loop.stop()
      return { outcome: 'empty' }
    })
    const loop = createWorkerLoop({
      runOnce,
      pollIntervalMs: 50,
      inFlight: new InFlightJob(),
      sleep,
    })

    await loop.run()

    // Looped straight back into a second claim after the successful first
    // one, with no sleep in between — proving "sleep only on empty", the
    // second call is where `stop()` actually lands.
    expect(runOnce).toHaveBeenCalledTimes(2)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('tracks every runOnce() call through inFlight, so shutdown can see one in progress', async () => {
    let releaseFirstCall: (result: { outcome: string }) => void = () => {}
    const runOnce = vi.fn().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirstCall = resolve
        })
    )
    const inFlight = new InFlightJob()
    const loop = createWorkerLoop({
      runOnce,
      pollIntervalMs: 10,
      inFlight,
      sleep: vi.fn().mockResolvedValue(undefined),
    })

    const runPromise = loop.run()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(inFlight.isRunning).toBe(true)

    // Stop before releasing, so the loop's own `if (stopping) break` exits
    // right after this one call settles — the loop never attempts a second
    // `runOnce()`, so `mockImplementationOnce` never needs a fallback.
    loop.stop()
    releaseFirstCall({ outcome: 'empty' })
    await runPromise

    expect(inFlight.isRunning).toBe(false)
    expect(runOnce).toHaveBeenCalledTimes(1)
  })

  it('a stop requested while sleeping does not start another claim once it wakes', async () => {
    const runOnce = vi.fn().mockResolvedValue({ outcome: 'empty' })
    const sleep = vi.fn().mockImplementation(async () => {
      // Stop lands mid-sleep, the way a real signal can arrive at any point.
      loop.stop()
    })
    const loop = createWorkerLoop({
      runOnce,
      pollIntervalMs: 5,
      inFlight: new InFlightJob(),
      sleep,
    })

    await loop.run()

    // Exactly one claim attempt: the loop slept once, called stop() from
    // inside that sleep, and never looped back for a second claim.
    expect(runOnce).toHaveBeenCalledTimes(1)
  })
})
