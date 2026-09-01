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
})
