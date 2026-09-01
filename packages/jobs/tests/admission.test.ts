/**
 * `createAdmissionGate` (JOB-4) — bounds concurrent holders of a slot, and
 * tells a caller past the wait ceiling plainly that it could not be served
 * rather than granting it or leaving it hanging. Real (short) timers
 * throughout, not fake ones: the whole point under test is *when* a promise
 * settles relative to another call, which a fake clock would have to be
 * manually advanced past anyway — real millisecond-scale timeouts keep this
 * fast and exercise the actual `setTimeout` path.
 */

import { describe, expect, it } from 'vitest'

import { createAdmissionGate } from '../src/admission.js'

describe('createAdmissionGate (JOB-4)', () => {
  it('grants immediately up to the configured limit', async () => {
    const gate = createAdmissionGate({ limit: 2, waitMs: 200 })

    const a = await gate.acquire()
    const b = await gate.acquire()

    expect(a.granted).toBe(true)
    expect(b.granted).toBe(true)
  })

  it('a caller past the limit waits for a slot rather than being refused outright', async () => {
    const gate = createAdmissionGate({ limit: 1, waitMs: 500 })
    const first = await gate.acquire()
    if (!first.granted) throw new Error('expected a grant')

    let secondSettled = false
    const secondPromise = gate.acquire().then((result) => {
      secondSettled = true
      return result
    })

    // Give the event loop a moment — the second caller must still be
    // waiting, not settled with a refusal, while the slot is held.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(secondSettled).toBe(false)

    first.release()
    const second = await secondPromise
    expect(second.granted).toBe(true)
  })

  // JOB-4's own test 5: with a bound of one, two concurrent callers
  // serialize rather than both being granted at once.
  it('with a bound of one, two concurrent callers serialize rather than both holding a slot at once', async () => {
    const gate = createAdmissionGate({ limit: 1, waitMs: 1000 })
    const events: string[] = []

    async function hold(name: string): Promise<void> {
      const result = await gate.acquire()
      if (!result.granted) throw new Error(`expected ${name} to be granted`)
      events.push(`${name}-start`)
      await new Promise((resolve) => setTimeout(resolve, 15))
      events.push(`${name}-end`)
      result.release()
    }

    await Promise.all([hold('a'), hold('b')])

    // Whichever ran first, its own start/end pair is never interrupted by
    // the other caller's start — proving only one held the slot at a time.
    const firstIsA = events[0] === 'a-start'
    expect(events).toEqual(
      firstIsA
        ? ['a-start', 'a-end', 'b-start', 'b-end']
        : ['b-start', 'b-end', 'a-start', 'a-end']
    )
  })

  // JOB-4's own test 5, the other half: a third caller beyond the wait
  // ceiling is told rather than hanging.
  it('a caller beyond the wait ceiling is told it could not be served, not left hanging', async () => {
    const gate = createAdmissionGate({ limit: 1, waitMs: 20 })
    const first = await gate.acquire()
    if (!first.granted) throw new Error('expected a grant')
    // Deliberately never released — the slot stays held for the rest of
    // this test.

    const startedAt = Date.now()
    const second = await gate.acquire()
    const elapsedMs = Date.now() - startedAt

    expect(second.granted).toBe(false)
    // Loose bounds: proves this waited roughly the ceiling and settled,
    // rather than resolving instantly or hanging indefinitely.
    expect(elapsedMs).toBeGreaterThanOrEqual(15)
    expect(elapsedMs).toBeLessThan(1000)
  })

  it('a waiter that already timed out is not later granted a slot a release frees', async () => {
    const gate = createAdmissionGate({ limit: 1, waitMs: 20 })
    const first = await gate.acquire()
    if (!first.granted) throw new Error('expected a grant')

    const timedOut = await gate.acquire()
    expect(timedOut.granted).toBe(false)

    // Releasing now must free the slot for a *fresh* caller, not silently
    // hand it to the waiter that already gave up.
    first.release()
    const fresh = await gate.acquire()
    expect(fresh.granted).toBe(true)
  })

  it('rejects a non-positive-integer limit', () => {
    expect(() => createAdmissionGate({ limit: 0, waitMs: 10 })).toThrow()
    expect(() => createAdmissionGate({ limit: 1.5, waitMs: 10 })).toThrow()
  })

  it('rejects a negative waitMs', () => {
    expect(() => createAdmissionGate({ limit: 1, waitMs: -1 })).toThrow()
  })
})
