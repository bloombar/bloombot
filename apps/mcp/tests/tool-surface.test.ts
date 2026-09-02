/**
 * MCP-2: the tool surface is an explicit allowlist, not everything
 * `createPlatformRegistry` happens to register. The first test below is
 * the requirement itself — it fails without `buildToolDefinitions`'s own
 * allowlist filter (proved by temporarily deriving the tool list from
 * `registry.list()` instead of `MCP_TOOL_SURFACE`, which makes this test
 * fail the moment a fresh action is registered into the test registry).
 */

import {
  ActionRegistry,
  createPlatformRegistry,
  type Action,
} from '@bloombot/actions'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { buildToolDefinitions, MCP_TOOL_SURFACE } from '../src/tool-surface.js'

/** A harmless action with no relationship to anything on the real allowlist — registering this and nothing else proves whether `buildToolDefinitions` leaks it in. */
function buildLeakProbeAction(): Action<
  'test.leakProbe',
  Record<string, never>,
  { ok: true },
  { ok: true }
> {
  return {
    name: 'test.leakProbe',
    description:
      'A fresh action registered only to prove it does not leak onto the MCP tool surface by default.',
    inputSchema: z.object({}),
    policy: {
      descriptor: { resource: 'organization', access: 'read' },
      resolve: () => ({ ok: true }),
    },
    execute: () => ({ ok: true }),
  }
}

describe('MCP-2 — the tool surface is chosen, not derived', () => {
  it('does not expose a newly registered action that is not on the allowlist', () => {
    // The real platform registry (so every allowlisted action already
    // resolves) plus one brand-new action nothing added to `MCP_TOOL_SURFACE`
    // — this is exactly what happens when a future slice registers a new
    // action into `createPlatformRegistry` without also editing this
    // file's own allowlist. This test fails without `buildToolDefinitions`'s
    // allowlist filter: replace it with `registry.list()` and this action
    // appears in the output.
    const registry = createPlatformRegistry()
    registry.register(buildLeakProbeAction())

    const names = buildToolDefinitions(registry).map(
      (definition) => definition.name
    )
    expect(names).not.toContain('test.leakProbe')
  })

  it('exposes every allowlisted action once resolved against the real platform registry, and nothing else', () => {
    const registry = createPlatformRegistry()
    const definitions = buildToolDefinitions(registry)

    expect(definitions.map((definition) => definition.name).sort()).toEqual(
      [...MCP_TOOL_SURFACE.map((entry) => entry.actionName)].sort()
    )
  })

  it('throws at startup if the allowlist names an action that is not actually registered', () => {
    // An empty registry: every name in MCP_TOOL_SURFACE is "missing" from
    // it, so this is the same failure a typo or a renamed action would
    // produce — loud, not a silently shrunken tool list.
    const registry = new ActionRegistry()
    expect(() => buildToolDefinitions(registry)).toThrow(
      /is not registered in the platform's action registry/
    )
  })

  it('marks courseAttachments.detach — and only it — destructive (MCP-4)', () => {
    const registry = createPlatformRegistry()
    const definitions = buildToolDefinitions(registry)

    const destructiveNames = definitions
      .filter((definition) => definition.destructive)
      .map((definition) => definition.name)

    expect(destructiveNames).toEqual(['courseAttachments.detach'])
  })

  it("merges a required organizationId into every tool's own input schema", () => {
    const registry = createPlatformRegistry()
    for (const definition of buildToolDefinitions(registry)) {
      const schema = definition.inputSchema as {
        properties?: Record<string, unknown>
        required?: string[]
      }
      expect(schema.properties?.['organizationId']).toBeDefined()
      expect(schema.required).toContain('organizationId')
    }
  })
})
