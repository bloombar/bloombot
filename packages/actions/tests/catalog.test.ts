/**
 * ACT-6: the registry derives a JSON-Schema catalog of every registered
 * action — name, description, input schema and access descriptor. The
 * schema is real JSON Schema (from `z.toJSONSchema`, not a hand-written
 * approximation of one) — proven here by actually validating a couple of
 * inputs against it with a small validator, rather than only inspecting its
 * shape.
 */

import { describe, expect, it } from 'vitest'

import { createPlatformRegistry } from '../src/actions/index.js'

/**
 * A deliberately small validator over the subset of JSON Schema
 * `z.toJSONSchema` actually emits for this package's own input schemas
 * (`object`/`array`/`string`/`number`/`integer`/`boolean`/`null`,
 * `properties`/`required`/`additionalProperties`, `items`, `enum`, `anyOf`,
 * `minLength`) — enough to prove the catalog's schemas are real and
 * functional, not a general-purpose JSON Schema implementation this package
 * has no reason to own.
 */
function validateAgainstJsonSchema(schema: unknown, value: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return true
  const s = schema as Record<string, unknown>

  if (Array.isArray(s.anyOf)) {
    return s.anyOf.some((branch) => validateAgainstJsonSchema(branch, value))
  }

  if (Array.isArray(s.enum)) {
    return s.enum.includes(value)
  }

  switch (s.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false
      }
      const record = value as Record<string, unknown>
      const properties = (s.properties ?? {}) as Record<string, unknown>
      const required = (s.required ?? []) as string[]
      for (const key of required) {
        if (!(key in record)) return false
      }
      if (s.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          if (!(key in properties)) return false
        }
      }
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (
          key in record &&
          !validateAgainstJsonSchema(propertySchema, record[key])
        ) {
          return false
        }
      }
      return true
    }
    case 'array': {
      if (!Array.isArray(value)) return false
      const items = s.items
      return items === undefined
        ? true
        : value.every((item) => validateAgainstJsonSchema(items, item))
    }
    case 'string':
      if (typeof value !== 'string') return false
      if (typeof s.minLength === 'number' && value.length < s.minLength) {
        return false
      }
      return true
    case 'number':
    case 'integer':
      return typeof value === 'number'
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return true
  }
}

describe('ACT-6 — machine-readable catalog', () => {
  const registry = createPlatformRegistry()
  const catalog = registry.catalog()

  it('lists every registered action with its name, description, input schema and access descriptor', () => {
    const names = catalog.map((entry) => entry.name).sort()
    expect(names).toEqual(
      [
        'projects.create',
        'projects.archive',
        'projects.unarchive',
        // PROJ-6 — added by this slice.
        'projects.rename',
        'projects.list',
        'projects.duplicate',
        'courses.save',
        'courses.enable',
        'courses.disable',
        'courses.list',
        'courses.get',
        'discordServers.remove',
        'discordServers.list',
        'discordServers.scaffold',
        'jobs.get',
        'jobs.list',
        'roster.import',
        'courseAttachments.attach',
        'courseAttachments.list',
        'courseAttachments.detach',
        'courseInstructions.save',
        'courseInstructions.list',
        'courseInstructions.restore',
        'costLedger.organizationUsage',
        'costLedger.setSpendingCap',
        'courseJoinLinks.create',
        'courseJoinLinks.list',
        'courseJoinLinks.revoke',
        // ENRL-12 — added by this slice.
        'courseJoinLinks.reveal',
        // FILE-6/WEB-31 — added by this slice.
        'courseWebSources.add',
        'courseWebSources.list',
        'courseWebSources.remove',
        'enrolments.listForPerson',
        'enrolments.checkAccess',
        'enrolments.end',
        'enrolments.reinstate',
        'enrolments.listForCourse',
        'memberships.grant',
        'memberships.list',
        'memberships.revoke',
        'membershipInvitations.create',
        'membershipInvitations.list',
        'membershipInvitations.revoke',
        'transcripts.read',
        'transcripts.listStudents',
        'transcripts.export',
        'transcripts.listExports',
        'transcripts.listAccessLog',
      ].sort()
    )

    for (const entry of catalog) {
      expect(typeof entry.description).toBe('string')
      expect(entry.description.length).toBeGreaterThan(0)
      expect(entry.descriptor.resource.length).toBeGreaterThan(0)
      expect(['read', 'write']).toContain(entry.descriptor.access)
    }
  })

  it('derives real JSON Schema for projects.create — draft 2020-12, an object with a required name', () => {
    const entry = catalog.find((e) => e.name === 'projects.create')
    expect(entry).toBeDefined()
    const schema = entry?.inputSchema as Record<string, unknown>

    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(schema.type).toBe('object')
    expect(schema.required).toEqual(['name'])
  })

  it('validates a couple of inputs against the derived projects.create schema', () => {
    const entry = catalog.find((e) => e.name === 'projects.create')
    const schema = entry?.inputSchema

    expect(validateAgainstJsonSchema(schema, { name: 'Fall 2026' })).toBe(true)
    // Empty string fails `minLength: 1`; a missing `name` fails `required`.
    expect(validateAgainstJsonSchema(schema, { name: '' })).toBe(false)
    expect(validateAgainstJsonSchema(schema, {})).toBe(false)
  })

  it('validates a couple of inputs against the derived courses.enable schema', () => {
    const entry = catalog.find((e) => e.name === 'courses.enable')
    const schema = entry?.inputSchema

    expect(validateAgainstJsonSchema(schema, { courseId: 'course-1' })).toBe(
      true
    )
    expect(validateAgainstJsonSchema(schema, { courseId: 42 })).toBe(false)
  })
})
