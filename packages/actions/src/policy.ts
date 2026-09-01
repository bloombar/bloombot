/**
 * ACT-2's policy shape.
 *
 * A policy pairs a machine-readable **descriptor** — the resource an action
 * protects, and the level of access it needs against it — with a `resolve`
 * function that turns an action's already-validated input into the
 * tenant-scoped entity `execute` is handed, or a refusal. Descriptors are
 * read by `registry.ts`'s catalog (ACT-6) and pinned by the access audit
 * index (ACT-5, `tests/access-audit.test.ts`); they are not themselves
 * enforced by `dispatch.ts` — each policy's own `resolve` is what actually
 * does the checking, the same way `packages/db`'s repos are each
 * individually responsible for scoping their own queries by
 * `organizationId` (TEN-2) rather than trusting a shared helper to do it for
 * them.
 */

import type { Database } from '@bloombot/db'

/** The resource an action's policy protects, and the access it requires against it (ACT-2, ACT-5, ACT-6). */
export interface AccessDescriptor {
  /** What kind of record this action reaches, e.g. `'project'`, `'course'`, `'organization'`. */
  resource: string
  /** The level of access this action needs against that resource. */
  access: 'read' | 'write'
}

/**
 * What `resolve` is handed: the organization the caller is acting within,
 * and the open database. Nothing else — ACT-2's second paragraph is explicit
 * that "policies read the database and nothing else": no model calls, no
 * HTTP, no metering, so a policy can never spend money nobody is attributed
 * for and can never be the reason a test needs a network.
 */
export interface PolicyContext {
  organizationId: string
  db: Database
}

/**
 * A policy. `resolve` returns the tenant-scoped `Entity` an action is
 * allowed to reach, or `undefined` to refuse. `undefined` is the only
 * refusal channel on purpose: a policy has no way to say "this id does not
 * exist" versus "this id belongs to someone else" even if it wanted to, so
 * `dispatch.ts` can turn every refusal into ACT-3's single, identical error
 * without a policy author ever having a chance to leak the distinction.
 */
export interface Policy<Input, Entity> {
  descriptor: AccessDescriptor
  resolve: (input: Input, context: PolicyContext) => Entity | undefined
}
