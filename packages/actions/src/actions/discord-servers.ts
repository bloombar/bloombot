/**
 * Actions over `packages/db`'s `discord-servers` repo (TEN-6) — removal
 * only. Installing a server is not an action: it needs the caller's own
 * account id to record as the installer and to scope the OAuth+PKCE state
 * that drives it (`@bloombot/actions`' own `DispatchContext`/`ExecuteContext`
 * carry an organization id, never an account id — ACT-2's policies are
 * scoped to a tenant, not to a caller within one), so that flow is
 * `apps/api`'s own bespoke routes instead, over `@bloombot/auth`'s
 * `discord-install.ts` and `@bloombot/discord-rest`. Removal needs neither —
 * `organizationId` alone is enough to mark a binding inactive — so it fits
 * this package's shape exactly, the same way `projects.archive` does.
 */

import { discordServers } from '@bloombot/db'
import { z } from 'zod'

import { ActionRefusedError } from '../errors.js'
import type { Action } from '../types.js'

type DiscordServerBinding = NonNullable<
  ReturnType<typeof discordServers.getActiveDiscordServerBinding>
>

const removeInputSchema = z.object({
  serverId: z.string().min(1),
})
type RemoveInput = z.infer<typeof removeInputSchema>

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
