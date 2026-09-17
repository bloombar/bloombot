/**
 * Actions over `packages/db`'s `organizations` repo (WEB-57):
 * `organizations.rename`, the first action this package registers directly
 * against an organization's own row rather than something scoped inside
 * one — `projects.create`/`projects.list` (`actions/projects.ts`) already
 * resolve the organization itself as their policy's entity, the same shape
 * this action's own policy takes below, but neither one writes to it.
 */

import { memberships, organizations } from '@bloombot/db'
import { z } from 'zod'

import { ActionRefusedError } from '../errors.js'
import type { Action } from '../types.js'

type Organization = NonNullable<
  ReturnType<typeof organizations.getOrganizationById>
>

/**
 * No existing precedent in this repository sets a maximum length on a
 * name a person types (`projects.rename`, `courses.save`'s own `title`, and
 * `accounts.createAccount`'s own `displayName` all accept any non-blank
 * string) — this is the first one WEB-57 requires ("over-long names are
 * refused"), so there is no existing constant to reuse. 200 characters is a
 * judgment call recorded in `docs/DECISIONS.md` D-120: generous enough for
 * any real organization's name, and short enough that a value this size is
 * unambiguously a mistake (a pasted paragraph, say) rather than a name.
 */
export const MAX_ORGANIZATION_NAME_LENGTH = 200

// `z.strictObject`, the same reason `memberships.ts#grantInputSchema`'s own
// comment gives: an unknown field deserves an explicit `action_input_invalid`
// refusal, not silent disregard. `.trim()` before `.min(1)` so a
// whitespace-only name (" ") fails the same blank check an empty string
// does, rather than passing validation and being stored as whitespace —
// the same order `roster.ts#importInputSchema`'s own `studentCategoryBaseName`
// already uses.
const renameInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(MAX_ORGANIZATION_NAME_LENGTH),
})
type RenameInput = z.infer<typeof renameInputSchema>

/**
 * WEB-57: rename an organization. Only an existing owner of *that*
 * organization may call it — `execute`'s own check, not the policy's, the
 * same split `memberships.ts#grantMembershipAction`'s own module comment
 * draws for the identical reason: `PolicyContext` (`policy.ts`) carries no
 * notion of the caller's own account id, only `organizationId` and `db`.
 *
 * The policy resolves the organization itself, the same "no existing
 * record to resolve *against*, the record being reached *is* the
 * organization" shape `projects.create`/`projects.list` (`actions/projects.ts`)
 * already take — TEN-2 scoping holds regardless: `getOrganizationById` only
 * ever returns the organization named by `context.organizationId` itself,
 * so a caller acting in one organization can never resolve, let alone
 * rename, another one.
 */
export const renameOrganizationAction: Action<
  'organizations.rename',
  RenameInput,
  Organization,
  Organization
> = {
  name: 'organizations.rename',
  description:
    "Rename the caller's own organization (WEB-57). Only an existing owner may call this.",
  inputSchema: renameInputSchema,
  policy: {
    descriptor: { resource: 'organization', access: 'write' },
    resolve: (_input, context) =>
      organizations.getOrganizationById(context.organizationId, context.db),
  },
  execute: ({ organizationId, input, accountId, db }) => {
    if (!accountId) throw new ActionRefusedError()

    // Only an owner of *this* organization may rename it — the same "is
    // the caller an owner of this organization" lookup
    // `memberships.ts#grantMembershipAction`'s own `callerMembership` check
    // already performs, for the identical reason (a policy cannot see the
    // caller's own account id, this file's own module comment above).
    const callerMembership = memberships.getMembership(
      organizationId,
      accountId,
      db
    )
    if (!callerMembership || callerMembership.role !== 'owner') {
      throw new ActionRefusedError()
    }

    const renamed = organizations.renameOrganization(
      organizationId,
      input.name,
      db
    )
    // Same TEN-2 race every other write in this package guards against, not
    // asserted away — the policy already proved this organization exists
    // moments earlier (`projects.ts#unarchiveProjectAction`'s own identical
    // guard).
    if (!renamed) throw new ActionRefusedError()
    return renamed
  },
}
