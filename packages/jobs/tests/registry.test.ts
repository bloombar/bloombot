/**
 * `HandlerRegistry` — a job kind maps to a function (JOB-1). Small enough
 * that these are really just documentation of the contract `runner.ts`
 * depends on.
 */

import { describe, expect, it, vi } from 'vitest'

import { HandlerRegistry } from '../src/registry.js'

describe('HandlerRegistry', () => {
  it('returns undefined for a kind nothing has registered', () => {
    const registry = new HandlerRegistry()
    expect(registry.get('unregistered')).toBeUndefined()
  })

  it('returns the handler registered for a kind', () => {
    const registry = new HandlerRegistry()
    const handler = vi.fn().mockResolvedValue(undefined)
    registry.register('send-welcome-email', handler)

    expect(registry.get('send-welcome-email')).toBe(handler)
  })

  it('kinds() lists every registered kind', () => {
    const registry = new HandlerRegistry()
    registry.register('a', vi.fn())
    registry.register('b', vi.fn())

    expect(registry.kinds().sort()).toEqual(['a', 'b'])
  })

  it('kinds() is empty for a fresh registry', () => {
    expect(new HandlerRegistry().kinds()).toEqual([])
  })

  it('a second registration for the same kind replaces the first', () => {
    const registry = new HandlerRegistry()
    const first = vi.fn()
    const second = vi.fn()
    registry.register('a', first)
    registry.register('a', second)

    expect(registry.get('a')).toBe(second)
    expect(registry.kinds()).toEqual(['a'])
  })
})
