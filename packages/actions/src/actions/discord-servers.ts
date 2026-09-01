/**
 * Actions over `packages/db`'s `discord-servers` repo (TEN-6, TEN-8) —
 * removal and, this slice, listing. Installing a server is not an action: it
 * needs the caller's own account id to record as the installer and to scope
 * the OAuth+PKCE state that drives it (`@bloombot/actions`' own
 * `DispatchContext`/`ExecuteContext` carry an organization id, never an
 * account id — ACT-2's policies are scoped to a tenant, not to a caller
 * within one), so that flow is `apps/api`'s own bespoke routes instead, over
 * `@bloombot/auth`'s `discord-install.ts` and `@bloombot/discord-rest`.
 * Removal and listing need neither — `organizationId` alone is enough for
 * both — so they fit this package's shape exactly, the same way
 * `projects.archive` and `projects.list` do.
 */

import { discordServers, organizations } from '@bloombot/db'
import { z } from 'zod'

import { ActionRefusedError } from '../errors.js'
import type { Action } from '../types.js'

type Organization = ReturnType<typeof organizations.getOrganizationById>
type DiscordServerBinding = NonNullable<
  ReturnType<typeof discordServers.getActiveDiscordServerBinding>
>

const removeInputSchema = z.object({
  serverId: z.string().min(1),
})
type RemoveInput = z.infer<typeof removeInputSchema>

const listInputSchema = z.object({})
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
