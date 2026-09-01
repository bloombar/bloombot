/**
 * ACT-1: the shape every write the platform can perform takes — a dotted
 * name, a description, a zod input schema, a declared access policy, an
 * optional metering hook, and an execute function. `dispatch.ts` is the one
 * pipeline that runs all of these in order (ACT-4); nothing outside it calls
 * `execute` directly.
 *
 * `policy` is not optional. ACT-2 requires that "an action with no
 * declaration does not compile" — here that is a plain, required property on
 * this interface, not a runtime check: an object literal assigned to (or
 * passed as) an `Action` that omits `policy` fails TypeScript's own
 * missing-property check before it ever reaches `ActionRegistry#register`
 * (`registry.ts`). See `docs/DECISIONS.md` for what this catches and what it
 * does not (a value built up through `any` or spread can still slip past
 * structural typing — the limit of every compile-time guarantee TypeScript
 * gives).
 */

import type { Database } from '@bloombot/db'
import type { ZodType } from 'zod'

import type { Policy } from './policy.js'

/**
 * What a metering hook is handed — everything it needs to attribute a
 * call's cost, and nothing it needs to look up itself. Deliberately the same
 * shape `execute` receives (`entity`, not raw input) so a meter can never
 * charge for a record the policy did not actually resolve.
 */
export interface MeterContext<Input, Entity> {
  organizationId: string
  input: Input
  entity: Entity
}

/**
 * Meters one call, after authorization and before execution (ACT-4). No
 * action in this slice supplies a real one — the cost ledger this hook is
 * meant to feed does not exist yet (see `docs/DECISIONS.md` for where it is
 * expected to be filled in); tests exercise the pipeline's own ordering with
 * a no-op.
 */
export type Meter<Input, Entity> = (
  context: MeterContext<Input, Entity>
) => void | Promise<void>

/**
 * What `execute` receives: the caller's organization, the validated input,
 * and — critically — the entity the *policy* resolved, not whatever id
 * `input` happened to carry (ACT-2). An action that wants to reach a record
 * reaches it through `entity`; nothing stops an action from reading an id
 * off `input` instead, but every action in `src/actions/` is written not to,
 * on purpose, so that reaching another organization's record requires
 * bypassing the policy rather than merely reading past it.
 */
export interface ExecuteContext<Input, Entity> {
  organizationId: string
  input: Input
  entity: Entity
  db: Database
}

/**
 * One action (ACT-1). `Name` is the dotted string literal naming it
 * (`'projects.create'`), `Input` the type the zod schema validates into,
 * `Entity` what the policy resolves and hands to `execute`, and `Output`
 * what `execute` returns.
 */
export interface Action<Name extends string, Input, Entity, Output> {
  name: Name
  description: string
  inputSchema: ZodType<Input>
  policy: Policy<Input, Entity>
  meter?: Meter<Input, Entity>
  execute: (context: ExecuteContext<Input, Entity>) => Output | Promise<Output>
}

/**
 * An action with its type parameters erased — what `ActionRegistry` actually
 * stores, since a single collection cannot share one concrete
 * `Input`/`Entity`/`Output` across every action registered in it. Only
 * `dispatch.ts` (given back the concrete `Action` a caller already has in
 * hand) restores the types; nothing reads `execute` off an `AnyAction` and
 * calls it directly.
 */
export type AnyAction = Action<string, unknown, unknown, unknown>
