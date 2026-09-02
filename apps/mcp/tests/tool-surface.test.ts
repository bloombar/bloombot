/**
 * MCP-2: the tool surface is an explicit allowlist, not everything
 * `createPlatformRegistry` happens to register. The first test below is
 * the requirement itself — it fails without `buildToolDefinitions`'s own
 * allowlist filter (proved by temporarily deriving the tool list from
 * `registry.list()` instead of `MCP_TOOL_SURFACE`, which makes this test
 * fail the moment a fresh action is registered into the test registry).
 *
 * `EXPECTED_DESTRUCTIVE`, below, is the same idiom
 * `packages/actions/tests/access-audit.test.ts` already uses for ACT-5: an
 * exhaustive table, keyed by every name in `MCP_TOOL_SURFACE`, that a
 * reviewer reads and edits by hand. `destructive: true` alone (with no
 * table cross-checking it) catches an entry gaining the marker unasked but
 * never catches one *losing* it — a rework finding: `courses.save` shipped
 * on the surface entirely unmarked despite deleting every category and
 * channel on every call, and the suite stayed green throughout, because
 * nothing pinned what the array *should* say. This table does: a tool
 * added to `MCP_TOOL_SURFACE` with no matching row here fails the first
 * test below, and a tool whose `destructive` flag stops matching this
 * table's own value fails the second — so weakening (or strengthening) the
 * marker is a one-line diff a reviewer actually sees, the same as ACT-5's
 * own descriptor table.
 */

import {
  ActionRegistry,
  createPlatformRegistry,
  type Action,
} from '@bloombot/actions'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  buildToolDefinitions,
  MCP_TOOL_SURFACE,
  type ToolSurfaceEntry,
} from '../src/tool-surface.js'

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

/**
 * Every entry `MCP_TOOL_SURFACE` names, and whether this repository has
 * deliberately decided it is destructive (MCP-4) — see `tool-surface.ts`'s
 * own module comment for the reasoning behind each `true` below.
 */
const EXPECTED_DESTRUCTIVE: Record<string, boolean> = {
  'projects.list': false,
  'courses.list': false,
  'courses.get': false,
  'courseAttachments.list': false,
  'courseInstructions.list': false,
  'discordServers.list': false,
  'enrolments.listForPerson': false,
  'enrolments.checkAccess': false,
  'costLedger.organizationUsage': false,
  'jobs.get': false,
  'projects.create': false,
  'projects.archive': false,
  'projects.unarchive': false,
  'projects.duplicate': false,
  // Replaces every category and channel on every call — see this file's
  // own module comment and `tool-surface.ts`'s.
  'courses.save': true,
  'courses.enable': false,
  'courses.disable': false,
  'courseInstructions.save': false,
  'courseInstructions.restore': false,
  'courseJoinLinks.create': false,
  'courseJoinLinks.revoke': false,
  'enrolments.end': false,
  // Deletes a knowledge-file from the model provider and this platform's
  // own record of it, with no restore path.
  'courseAttachments.detach': true,
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

  describe('EXPECTED_DESTRUCTIVE — the ACT-5-style access-audit idiom, applied to MCP-4', () => {
    it('has a row for every action MCP_TOOL_SURFACE names — an entry added there with no row here fails here, not silently', () => {
      const surfaceNames = MCP_TOOL_SURFACE.map(
        (entry) => entry.actionName
      ).sort()
      const tableNames = Object.keys(EXPECTED_DESTRUCTIVE).sort()
      expect(tableNames).toEqual(surfaceNames)
    })

    it("matches MCP_TOOL_SURFACE's own destructive flag for every entry — a flag that drifts from this table fails here", () => {
      const registry = createPlatformRegistry()
      const actual = Object.fromEntries(
        buildToolDefinitions(registry).map((definition) => [
          definition.name,
          definition.destructive,
        ])
      )
      expect(actual).toEqual(EXPECTED_DESTRUCTIVE)
    })
  })

  it('throws if a destructive entry has no describeTarget — a confirmation with nothing to say what it destroys is not a real confirmation', () => {
    const registry = createPlatformRegistry()
    const surface: ToolSurfaceEntry[] = [
      { actionName: 'courseAttachments.detach', destructive: true },
    ]
    expect(() => buildToolDefinitions(registry, surface)).toThrow(
      /is marked destructive but has no describeTarget/
    )
  })

  it('buildToolDefinitions accepts an injected surface, for a test that needs a tool the real allowlist does not have (MCP-5)', () => {
    const registry = new ActionRegistry()
    registry.register(buildLeakProbeAction())
    const surface: ToolSurfaceEntry[] = [{ actionName: 'test.leakProbe' }]

    const definitions = buildToolDefinitions(registry, surface)

    expect(definitions.map((definition) => definition.name)).toEqual([
      'test.leakProbe',
    ])
  })

  describe("jobs.get's output is sanitized — a job's own payload can carry PII (a roster CSV) this surface must not hand to a model", () => {
    it('strips payload from a real jobs.get definition', () => {
      const registry = createPlatformRegistry()
      const jobsGet = buildToolDefinitions(registry).find(
        (definition) => definition.name === 'jobs.get'
      )
      expect(jobsGet?.sanitizeOutput).toBeTypeOf('function')

      const sanitized = jobsGet?.sanitizeOutput?.({
        id: 'job-1',
        kind: 'roster.import',
        payload: {
          courseId: 'course-1',
          csvText: 'name,email\nA,a@example.edu',
        },
        result: null,
      })

      expect(sanitized).not.toHaveProperty('payload')
      expect(sanitized).toMatchObject({ id: 'job-1', kind: 'roster.import' })
    })

    it('leaves a non-object output untouched, rather than throwing', () => {
      const registry = createPlatformRegistry()
      const jobsGet = buildToolDefinitions(registry).find(
        (definition) => definition.name === 'jobs.get'
      )
      expect(jobsGet?.sanitizeOutput?.(null)).toBeNull()
      expect(jobsGet?.sanitizeOutput?.('not an object')).toBe('not an object')
    })
  })
})
