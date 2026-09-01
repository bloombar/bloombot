/**
 * ACT-5's access audit index: every registered action, pinned to its own
 * declared descriptor here — a table a reviewer reads, not just the type
 * system. Weakening a guard (e.g. `access: 'write'` softened to `'read'`)
 * still type-checks; it shows up here as a one-line diff against
 * `EXPECTED_DESCRIPTORS`, and this test fails until that diff is made.
 * Registering a new action without adding its row here fails the first
 * assertion below.
 *
 * No action in this slice authorizes itself by exception — every `resolve`
 * below is a real tenant-scoped lookup — so there is nothing to record for
 * that case yet; the day one exists, its reason belongs in a comment on its
 * row in `EXPECTED_DESCRIPTORS`.
 */

import { describe, expect, it } from 'vitest'

import { createPlatformRegistry } from '../src/actions/index.js'
import type { AccessDescriptor } from '../src/policy.js'

const EXPECTED_DESCRIPTORS: Record<string, AccessDescriptor> = {
  // No existing project to resolve on create — the record it protects is
  // the organization a new project is created inside (`actions/projects.ts`).
  'projects.create': { resource: 'organization', access: 'write' },
  'projects.archive': { resource: 'project', access: 'write' },
  'projects.unarchive': { resource: 'project', access: 'write' },
  // Resolves the *project* a course is saved into, whether creating or
  // updating (`actions/courses.ts`'s `CourseSaveEntity`) — an update also
  // resolves the existing course, but the descriptor names the one
  // resource every save requires. Finding 10 (rework pass): on the update
  // path, `execute` actually *writes* a course, not a project — nothing
  // enforces descriptors yet (`policy.ts`), but the day something does, an
  // actor permitted to write projects would be permitted to rewrite courses
  // through this action (see `docs/DECISIONS.md` D-18).
  'courses.save': { resource: 'project', access: 'write' },
  'courses.enable': { resource: 'course', access: 'write' },
  'courses.disable': { resource: 'course', access: 'write' },
}

describe('ACT-5 — access audit index', () => {
  const registry = createPlatformRegistry()

  it('registers exactly the actions this table expects — no more, no fewer', () => {
    const registeredNames = registry
      .list()
      .map((action) => action.name)
      .sort()
    expect(registeredNames).toEqual(Object.keys(EXPECTED_DESCRIPTORS).sort())
  })

  for (const [name, descriptor] of Object.entries(EXPECTED_DESCRIPTORS)) {
    it(`${name} is guarded exactly as recorded here`, () => {
      const action = registry.get(name)
      expect(action, `expected an action registered as "${name}"`).toBeDefined()
      expect(action?.policy.descriptor).toEqual(descriptor)
    })
  }
})
