/**
 * ACT-1's single write path, addressable by name: registration, lookup, and
 * (ACT-6) a JSON-Schema catalog derived from what is actually registered,
 * not hand-maintained alongside it.
 *
 * A plain class rather than a module-level singleton, so a test builds its
 * own registry instead of sharing (and mutating) the platform's one; nothing
 * here does any I/O, so building one at import time would be harmless
 * anyway, but `src/actions/index.ts#createPlatformRegistry` still builds the
 * real one lazily, matching PLAT-5's "nothing happens at import time"
 * convention this repo holds every package to.
 */

import { z } from 'zod'

import type { AccessDescriptor } from './policy.js'
import type { Action, AnyAction } from './types.js'

/** One entry in ACT-6's catalog — everything an AI channel (or a reviewer) needs to know about a registered action, without reaching into its `execute`. */
export interface CatalogEntry {
  name: string
  description: string
  /** Real JSON Schema (draft 2020-12), derived from the action's own zod input schema via `z.toJSONSchema` — not a hand-written approximation of it. */
  inputSchema: object
  descriptor: AccessDescriptor
}

export class ActionRegistry {
  private readonly actionsByName = new Map<string, AnyAction>()

  /**
   * Register an action. ACT-2's "an action with no policy does not compile"
   * is enforced by `Action`'s own type (`types.ts`) before an object literal
   * ever reaches this call; this guards the two things the type system
   * cannot — two actions registered under the same name, and (finding 8,
   * rework pass) an action whose `policy` slipped past that compile-time
   * check anyway (`as any`, a cast — see `docs/DECISIONS.md` D-18's "What
   * this does not catch"). Without this, a smuggled action fails much
   * later and confusingly: `catalog()` throwing `TypeError: Cannot read
   * properties of undefined (reading 'descriptor')`, or `dispatch.ts`
   * throwing a raw `TypeError` calling `.resolve` instead of refusing. This
   * is the one place both of those would otherwise first surface, so it is
   * the one place that refuses to register such an action at all.
   */
  register<Name extends string, Input, Entity, Output>(
    action: Action<Name, Input, Entity, Output>
  ): void {
    if (this.actionsByName.has(action.name)) {
      throw new Error(`An action is already registered as "${action.name}".`)
    }
    if (
      typeof action.policy !== 'object' ||
      action.policy === null ||
      typeof action.policy.resolve !== 'function' ||
      typeof action.policy.descriptor !== 'object' ||
      action.policy.descriptor === null
    ) {
      throw new Error(
        `Action "${action.name}" has no valid policy; refusing to register it.`
      )
    }
    // Type parameters are erased on the way into a heterogeneous map
    // (`AnyAction`, `types.ts`); `dispatch.ts` is always called with the
    // concrete `Action` a caller already has in hand, never with whatever
    // `get`/`list` return here, so nothing depends on this cast being
    // narrowed back.
    this.actionsByName.set(action.name, action as unknown as AnyAction)
  }

  /** Look up a registered action by its dotted name, or `undefined`. */
  get(name: string): AnyAction | undefined {
    return this.actionsByName.get(name)
  }

  /** Every registered action, in registration order. */
  list(): AnyAction[] {
    return [...this.actionsByName.values()]
  }

  /** ACT-6: name, description, input schema (as real JSON Schema) and access descriptor, for every registered action. */
  catalog(): CatalogEntry[] {
    return this.list().map((action) => ({
      name: action.name,
      description: action.description,
      inputSchema: z.toJSONSchema(action.inputSchema),
      descriptor: action.policy.descriptor,
    }))
  }
}
