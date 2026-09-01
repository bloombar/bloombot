/**
 * `ActionRegistry` itself (`registry.ts`): registration, lookup, and the one
 * thing the type system cannot catch — two actions registered under the
 * same name.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { ActionRegistry } from '../src/registry.js'
import type { Action } from '../src/types.js'

function buildAction<Name extends 'test.a' | 'test.b'>(
  name: Name
): Action<Name, { id: string }, { id: string }, string> {
  return {
    name,
    description: `Action ${name}.`,
    inputSchema: z.object({ id: z.string() }),
    policy: {
      descriptor: { resource: 'test', access: 'read' },
      resolve: (input) => ({ id: input.id }),
    },
    execute: () => 'ok',
  }
}

describe('ActionRegistry', () => {
  it('registers and looks up an action by name', () => {
    const registry = new ActionRegistry()
    const action = buildAction('test.a')

    registry.register(action)

    expect(registry.get('test.a')).toBe(action)
    expect(registry.get('does.not.exist')).toBeUndefined()
    expect(registry.list()).toEqual([action])
  })

  it('refuses to register two actions under the same name', () => {
    const registry = new ActionRegistry()
    registry.register(buildAction('test.a'))

    expect(() => registry.register(buildAction('test.a'))).toThrow(
      /already registered as "test.a"/
    )
  })

  // Finding 8 (rework pass): a `policy` smuggled past the type system with
  // `as any` used to compile, register, and only fail later, confusingly —
  // `catalog()` throwing `TypeError: Cannot read properties of undefined
  // (reading 'descriptor')`, or `dispatch.ts` throwing a raw `TypeError`
  // calling `.resolve`. `register` now catches it at the one point both of
  // those would otherwise first surface.
  it('refuses to register an action whose policy was smuggled past the type system', () => {
    const registry = new ActionRegistry()
    const brokenAction = {
      name: 'test.broken',
      description: 'An action with no real policy.',
      inputSchema: z.object({ id: z.string() }),
      policy: undefined,
      execute: () => 'ok',
    } as unknown as Action<
      'test.broken',
      { id: string },
      { id: string },
      string
    >

    expect(() => registry.register(brokenAction)).toThrow(
      /"test\.broken" has no valid policy/
    )
    expect(registry.get('test.broken')).toBeUndefined()
  })

  it('refuses to register an action whose policy has no resolve function', () => {
    const registry = new ActionRegistry()
    const brokenAction = {
      name: 'test.broken-resolve',
      description: 'An action with a descriptor but no resolver.',
      inputSchema: z.object({ id: z.string() }),
      policy: { descriptor: { resource: 'test', access: 'read' } },
      execute: () => 'ok',
    } as unknown as Action<
      'test.broken-resolve',
      { id: string },
      { id: string },
      string
    >

    expect(() => registry.register(brokenAction)).toThrow(
      /"test\.broken-resolve" has no valid policy/
    )
  })
})
