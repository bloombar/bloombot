/**
 * Actions over `packages/db`'s `discord-servers` repo (TEN-6, TEN-8) —
 * removal, listing and, this slice, SRV-6's scaffold request. Installing a
 * server is not an action: it needs the caller's own account id to record as
 * the installer and to scope the OAuth+PKCE state that drives it
 * (`@bloombot/actions`' own `DispatchContext`/`ExecuteContext` carry an
 * organization id, never an account id — ACT-2's policies are scoped to a
 * tenant, not to a caller within one), so that flow is `apps/api`'s own
 * bespoke routes instead, over `@bloombot/auth`'s `discord-install.ts` and
 * `@bloombot/discord-rest`. Removal, listing and scaffolding need neither —
 * `organizationId` alone is enough for all three — so they fit this
 * package's shape exactly, the same way `projects.archive` and
 * `projects.list` do.
 *
 * `scaffoldDiscordServerAction` (SRV-6) is deliberately thin: ACT-4's
 * validate/authorize/execute pipeline resolves the course and enqueues a
 * job (`@bloombot/db`'s own `jobs.enqueueJob`) — it never touches Discord
 * itself. The work happens when `apps/worker`'s
 * `handlers/discord-scaffold.ts` claims that job, which is also what
 * `docs/DECISIONS.md`'s D-29 addendum means by "the queue's first real
 * consumer": dispatching this action creates a row and makes no Discord
 * call at all, proven in `tests/discord-servers.test.ts`.
 */

import { courses, discordServers, jobs, organizations } from '@bloombot/db'
import { z } from 'zod'

import { ActionRefusedError } from '../errors.js'
import type { Action } from '../types.js'

type Organization = ReturnType<typeof organizations.getOrganizationById>
type DiscordServerBinding = NonNullable<
  ReturnType<typeof discordServers.getActiveDiscordServerBinding>
>
type Course = NonNullable<ReturnType<typeof courses.getCourse>>

// The job `kind` `apps/worker`'s `handlers/discord-scaffold.ts` registers
// its handler under (that file's own `DISCORD_SCAFFOLD_JOB_KIND`) — a
// literal string here too, for the same reason that file's own comment
// gives: an app does not import from another app, and this package does
// not depend on `apps/worker`.
const DISCORD_SCAFFOLD_JOB_KIND = 'discordServers.scaffold'

// JOB-2's bound on attempts for a scaffold job — a plain constant here
// rather than a shared default (`docs/DECISIONS.md` D-29's rework finding
// 4: `packages/jobs` deleted its own shared `maxAttempts` default because
// nothing read it; each enqueuing call site sets its own, deliberately).
// Five gives a transient Discord failure (a rate limit, a momentary
// network blip) room to clear on retry without a stuck job lingering
// indefinitely.
const SCAFFOLD_MAX_ATTEMPTS = 5

const removeInputSchema = z.object({
  serverId: z.string().min(1),
})
type RemoveInput = z.infer<typeof removeInputSchema>

// Finding 5 (rework pass): `.default({})`, not a bare `z.object({})` — this
// action takes no input at all, so a browser client always sends `{}`, but a
// body-less `POST` (no matching `Content-Type` header, so express 5 leaves
// `req.body` `undefined` — `routes/actions.ts`) fails `safeParse(undefined)`
// against a plain `z.object({})` before it ever reaches this action's
// policy. Only `dispatch`'s own tests and this package's own tests ever
// called this with `{}` explicitly, which is why nothing caught it.
const listInputSchema = z.object({}).default({})
type ListInput = z.infer<typeof listInputSchema>

/**
 * TEN-8: list every Discord server binding — active or removed — the
 * caller's organization has ever held. No existing binding to resolve
 * against (a caller may hold none at all), so the policy resolves the
 * organization itself, the same shape `projects.list`'s own policy uses.
 *
 * A removed binding is shown *as removed* (`removedAt` set), not omitted —
 * see `docs/DECISIONS.md` for why: the panel's own "what is already
 * installed" screen (D-22's gap 2) needs to distinguish "never installed"
 * from "installed, then removed," and `listDiscordServerBindingsForOrganization`
 * (`repos/discord-servers.ts`) already returns exactly that distinction —
 * narrowing it to active-only here would throw the information away for no
 * reason.
 */
export const listDiscordServersAction: Action<
  'discordServers.list',
  ListInput,
  NonNullable<Organization>,
  discordServers.DiscordServerBinding[]
> = {
  name: 'discordServers.list',
  description:
    "List every Discord server binding — active or removed — the caller's organization has ever held.",
  inputSchema: listInputSchema,
  policy: {
    descriptor: { resource: 'organization', access: 'read' },
    resolve: (_input, context) =>
      organizations.getOrganizationById(context.organizationId, context.db),
  },
  execute: ({ organizationId, db }) =>
    discordServers.listDiscordServerBindingsForOrganization(organizationId, db),
}

export const removeDiscordServerAction: Action<
  'discordServers.remove',
  RemoveInput,
  DiscordServerBinding,
  { removed: boolean }
> = {
  name: 'discordServers.remove',
  description:
    "Remove the bot from a Discord server bound to the caller's organization (TEN-6): marks the binding inactive without deleting anything.",
  inputSchema: removeInputSchema,
  policy: {
    descriptor: { resource: 'discordServer', access: 'write' },
    resolve: (input, context) =>
      discordServers.getActiveDiscordServerBinding(
        context.organizationId,
        input.serverId,
        context.db
      ),
  },
  execute: ({ organizationId, entity, db }) => {
    const changed = discordServers.removeDiscordServerBinding(
      organizationId,
      entity.serverId,
      db
    )
    // Unreachable in practice — the policy just proved this binding was
    // active and belonged to this organization moments earlier — but
    // guarded rather than assumed, the same race the policy's own comment
    // documents for a concurrent removal, matching `unarchiveProjectAction`'s
    // own treatment of the same class of race.
    if (changed === 0) throw new ActionRefusedError()
    return { removed: true }
  },
}

const scaffoldInputSchema = z.object({
  courseId: z.string().min(1),
})
type ScaffoldInput = z.infer<typeof scaffoldInputSchema>

/**
 * SRV-6: request that a course's declared categories and channels be
 * created in its organization's bound Discord server. Resolves the course
 * itself (scoped to the caller's organization, ACT-2) and enqueues a
 * `discordServers.scaffold` job naming it — which server, and every
 * permission the job needs to reason about, is `apps/worker`'s own handler's
 * concern once it claims the row, not this action's.
 */
export const scaffoldDiscordServerAction: Action<
  'discordServers.scaffold',
  ScaffoldInput,
  Course,
  { jobId: string }
> = {
  name: 'discordServers.scaffold',
  description:
    "Create a course's declared categories and channels in its bound Discord server (SRV-6), as a background job — this action enqueues the work; it does not perform it.",
  inputSchema: scaffoldInputSchema,
  policy: {
    descriptor: { resource: 'course', access: 'write' },
    resolve: (input, context) =>
      courses.getCourse(context.organizationId, input.courseId, context.db),
  },
  execute: ({ organizationId, entity, db }) => {
    const job = jobs.enqueueJob(
      organizationId,
      {
        kind: DISCORD_SCAFFOLD_JOB_KIND,
        payload: { courseId: entity.id },
        maxAttempts: SCAFFOLD_MAX_ATTEMPTS,
      },
      db
    )
    return { jobId: job.id }
  },
}
