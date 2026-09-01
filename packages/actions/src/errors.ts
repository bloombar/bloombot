/**
 * The typed errors `dispatch.ts` raises, and (ACT-4) a pure table mapping
 * each to an HTTP status — a table an eventual API slice imports so every
 * route maps a failure the same way, not middleware this package has any
 * business owning: this package must never know it is called over a
 * network.
 */

import type { ZodIssue } from 'zod'

/** The input failed the action's own zod schema — dispatch never reaches the policy for a call shaped like this. */
export class ActionInputError extends Error {
  readonly code = 'action_input_invalid'
  readonly issues: ZodIssue[]

  constructor(issues: ZodIssue[]) {
    super('The input for this action failed validation.')
    this.name = 'ActionInputError'
    this.issues = issues
  }
}

/**
 * ACT-3's single refusal: the record named in the input does not exist, or
 * exists but the caller has no access to it. Carries nothing about the
 * record it protected — not even which of the two happened — so every
 * instance is byte-identical: same `name`, same `message`, same `code`,
 * whatever the reason. See `docs/DECISIONS.md` for why `ActionConflictError`
 * (below) is allowed to say more.
 */
export class ActionRefusedError extends Error {
  readonly code = 'action_refused'

  constructor() {
    super('This record does not exist or you do not have access to it.')
    this.name = 'ActionRefusedError'
  }
}

/**
 * A repo-level refusal that *does* name what it collided with — PROJ-3's or
 * TEN-5's `{ ok: false, conflict }` shape (`packages/db/src/repos/*.ts`),
 * mapped here rather than let leak out of `dispatch.ts` as if it were a
 * success. `conflict` carries whatever the repo's own conflict object
 * carried (a field, a name, and what it collided with) — see
 * `docs/DECISIONS.md` for why naming a collision is safe in a way naming a
 * not-found is not.
 */
export class ActionConflictError extends Error {
  readonly code = 'action_conflict'
  readonly conflict: unknown

  constructor(conflict: { message: string }) {
    super(conflict.message)
    this.name = 'ActionConflictError'
    this.conflict = conflict
  }
}

/** No action is registered under the given name. */
export class UnknownActionError extends Error {
  readonly code = 'action_unknown'

  constructor(name: string) {
    super(`No action is registered as "${name}".`)
    this.name = 'UnknownActionError'
  }
}

/**
 * ACT-4's "typed errors are mapped to HTTP statuses by one middleware; no
 * route maps its own" — the table half of that. A plain lookup by `code`,
 * exported for the API slice to build its one middleware from, rather than
 * reimplemented per route.
 */
export const HTTP_STATUS_BY_ACTION_ERROR: Readonly<Record<string, number>> = {
  action_input_invalid: 400,
  action_refused: 404,
  action_conflict: 409,
  action_unknown: 404,
}
